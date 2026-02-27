/**
 * 说明：基于 acme.sh 实现 DNS 手动解析的验证方式、实现自助申请、验证、下载功能
 * 版本：v1.0 | 开发、维护：小七安全团队
 * 环境：Node.js >= 16（CommonJS 规范）
 */
const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const winston = require('winston');
const { CronJob } = require('cron');
// 适配 CommonJS 的 uuid 8.x 版本
const { v4: uuidv4 } = require('uuid');

// 异步化系统命令执行
const execFileAsync = promisify(execFile);

// ======================== 配置项（可通过环境变量覆盖） ========================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ACME_SH_PATH: '/home/.acme.sh/acme.sh',
  CERT_DIR: path.join(__dirname, 'certs'),
  ZIP_DIR: path.join(__dirname, 'zip'),
  LOG_DIR: path.join(__dirname, 'logs'),
  CERT_STORAGE_DIR: '/home/.acme.sh',
  // 过期文件清理时间（小时）
  EXPIRE_HOURS: 24,
  // 命令执行超时（毫秒）
  CMD_TIMEOUT: 60000,
  // 验证重试次数
  VERIFY_RETRY_TIMES: 3,
  // 重试间隔（毫秒）
  RETRY_INTERVAL: 10000,
  // CORS 白名单（生产环境替换为具体域名，如 "https://yourdomain.com"）
  CORS_WHITELIST: process.env.CORS_WHITELIST ? process.env.CORS_WHITELIST.split(',') : ['*'],
  // 是否启用 sudo（建议生产环境配置免密）
  USE_SUDO: process.env.USE_SUDO === 'false' ? false : true,
  // 运行环境
  NODE_ENV: process.env.NODE_ENV || 'production',
  // acme.sh 允许的非致命提示（忽略这些错误）
  ALLOWED_ACME_SH_WARNINGS: [
    'Cannot find DNS API hook for: dns_manual',
    'You need to add the TXT record manually'
  ]
};

// ======================== 日志系统初始化 ========================
const logger = winston.createLogger({
  level: CONFIG.NODE_ENV === 'development' ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [
    // 控制台输出（开发环境彩色）
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          return `[${timestamp}] [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      )
    }),
    // 错误日志文件
    new winston.transports.File({ 
      filename: path.join(CONFIG.LOG_DIR, 'error.log'), 
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // 所有日志文件
    new winston.transports.File({ 
      filename: path.join(CONFIG.LOG_DIR, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ]
});

// ======================== Express 应用初始化 ========================
const app = express();

// 1. 请求体解析（解决大请求体限制）
app.use(express.json({
  limit: '50MB',
  parameterLimit: 100000,
  inflate: true
}));
app.use(express.urlencoded({
  extended: true,
  limit: '50MB',
  parameterLimit: 100000
}));

// 2. CORS 配置（安全版）
app.use(cors({
  origin: (origin, callback) => {
    // 允许跨域的情况：白名单包含*，或包含当前origin，或本地请求（无origin）
    if (!origin || CONFIG.CORS_WHITELIST.includes('*') || CONFIG.CORS_WHITELIST.includes(origin)) {
      callback(null, true);
    } else {
      const err = new Error(`CORS 禁止访问：${origin} 不在白名单中`);
      logger.warn(err.message);
      callback(err, false);
    }
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400
}));

// 3. 全局超时中间件
app.use((req, res, next) => {
  req.connection.setTimeout(120000); // 2分钟超时
  next();
});

// 4. 日志中间件（记录请求）
app.use((req, res, next) => {
  const requestId = uuidv4();
  req.requestId = requestId;
  
  // 记录请求信息
  logger.info(`收到请求`, {
    requestId,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  
  // 记录响应信息
  const originalSend = res.send;
  res.send = function (body) {
    logger.info(`响应请求`, {
      requestId,
      statusCode: res.statusCode,
      responseSize: body ? Buffer.byteLength(body) : 0
    });
    return originalSend.call(this, body);
  };
  
  next();
});

// ======================== 工具函数 ========================

/**
 * 统一响应函数
 * @param {Request} req - Express 请求对象
 * @param {Response} res - Express 响应对象
 * @param {number} code - 状态码
 * @param {string} message - 提示信息
 * @param {object} data - 响应数据
 */
const response = (req, res, code, message, data = {}) => {
  const responseData = { 
    code, 
    message, 
    data: {
      requestId: req.requestId || 'unknown',
      ...data
    }
  };
  res.status(code).json(responseData);
};

/**
 * 创建目录（不存在则创建）
 * @param {string} dirPath - 目录路径
 */
const createDirIfNotExist = async (dirPath) => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o755 });
    logger.info(`创建目录成功`, { dirPath });
  }
};

/**
 * 检查 acme.sh 可用性
 */
const checkAcmeSh = () => {
  // 检查文件是否存在
  if (!fsSync.existsSync(CONFIG.ACME_SH_PATH)) {
    const errorMsg = `acme.sh 文件不存在：${CONFIG.ACME_SH_PATH}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  // 检查执行权限
  try {
    fsSync.accessSync(CONFIG.ACME_SH_PATH, fsSync.constants.X_OK);
  } catch (err) {
    const errorMsg = `acme.sh 无执行权限，请执行：chmod +x ${CONFIG.ACME_SH_PATH}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
};

/**
 * 安全执行系统命令（防止注入）
 * 适配：中文日期格式的 acme.sh 输出，优化错误处理
 * @param {Request} req - Express 请求对象
 * @param {string[]} args - 命令参数
 * @returns {Promise<string>} 命令输出
 */
const executeAcmeShCommand = async (req, args) => {
  try {
    // 处理 sudo
    let cmd = CONFIG.ACME_SH_PATH;
    let cmdArgs = args;
    
    if (CONFIG.USE_SUDO) {
      cmd = 'sudo';
      cmdArgs = [CONFIG.ACME_SH_PATH, ...args];
    }

    logger.debug(`执行系统命令`, {
      requestId: req.requestId,
      cmd,
      args: cmdArgs
    });
    
    // 执行命令（允许 stderr 有正常提示）
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: CONFIG.CMD_TIMEOUT,
      maxBuffer: 1024 * 1024 * 5 // 5MB 输出缓冲区
    });
    
    const output = stdout + stderr;
    logger.debug(`命令执行完成`, {
      requestId: req.requestId,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      fullOutput: output
    });
    
    // 检查是否是 dns_manual 模式的正常提示，而非致命错误
    const isDnsManualMode = args.includes('--dns') && args.includes('dns_manual');
    let isFatalError = false;
    
    if (isDnsManualMode) {
      // 识别常见的非致命/致命错误
      const fatalErrorKeywords = [
        'No such file or directory',
        'Permission denied',
        'Timeout',
        'Invalid domain',
        'Failed to authorize'
      ];
      
      // 特殊处理：TXT 记录错误
      if (output.includes('Incorrect TXT record')) {
        throw new Error(`DNS TXT 记录验证失败：
1. 请检查 _acme-challenge.${req.query.domain || req.body.domain} 的 TXT 记录值是否与生成的完全一致（区分大小写）
2. 确保 DNS 解析已全网生效（可通过 nslookup -type=TXT _acme-challenge.${req.query.domain || req.body.domain} 验证）
3. 删除多余的 _acme-challenge TXT 记录，只保留最新的一条
4. 等待 5-10 分钟后重试（DNS 生效需要时间）`);
      }
      
      // 特殊处理：CA 处理中
      if (output.includes('Pending. The CA is processin')) {
        throw new Error(`CA 正在处理验证请求：请等待几分钟后重试，或检查 DNS 解析是否生效`);
      }
      
      isFatalError = fatalErrorKeywords.some(keyword => 
        output.toLowerCase().includes(keyword.toLowerCase())
      );
      
      // 忽略允许的警告
      CONFIG.ALLOWED_ACME_SH_WARNINGS.forEach(warning => {
        if (output.includes(warning)) {
          logger.debug(`忽略 acme.sh 非致命提示`, {
            requestId: req.requestId,
            warning
          });
        }
      });
    } else {
      // 非 dns_manual 模式，stderr 非空则视为错误
      isFatalError = stderr && stderr.trim().length > 0 && !stdout.includes('Success');
    }
    
    if (isFatalError) {
      //throw new Error(`命令执行失败：${stderr || stdout}`);
      throw new Error(`命令执行失败`);
    }
    
    return output;
  } catch (err) {
    // 特殊处理：如果是 dns_manual 模式且输出包含 TXT 记录，视为成功
    if (err.stdout || err.stderr) {
      const combinedOutput = (err.stdout || '') + (err.stderr || '');
      const hasTxtRecord = combinedOutput.includes('_acme-challenge.') && combinedOutput.includes('TXT value:');
      
      if (hasTxtRecord) {
        logger.warn(`dns_manual 模式命令返回非零码，但已生成 TXT 记录`, {
          requestId: req.requestId,
          error: err.message,
          fullOutput: combinedOutput
        });
        return combinedOutput;
      }
    }
    
    //const errorMsg = `命令执行失败：${err.message}`;
    const errorMsg = `命令执行失败`;
    logger.error(errorMsg, {
      requestId: req.requestId,
      stack: err.stack,
      stdout: err.stdout,
      stderr: err.stderr,
      fullOutput: (err.stdout || '') + (err.stderr || '')
    });
    //throw new Error(`${errorMsg}（输出：${(err.stdout || err.stderr || '').substring(0, 500)}）`);
    throw new Error(`${errorMsg}`);
  }
};

/**
 * 带重试机制执行命令
 * @param {Request} req - Express 请求对象
 * @param {string[]} args - 命令参数
 * @returns {Promise<string>} 命令输出
 */
const executeWithRetry = async (req, args) => {
  let retryCount = 0;
  let lastError;
  
  while (retryCount < CONFIG.VERIFY_RETRY_TIMES) {
    try {
      return await executeAcmeShCommand(req, args);
    } catch (err) {
      retryCount++;
      lastError = err;
      logger.warn(`命令执行失败，正在重试（${retryCount}/${CONFIG.VERIFY_RETRY_TIMES}）`, {
        requestId: req.requestId,
        error: err.message,
        retryInterval: CONFIG.RETRY_INTERVAL / 1000 + '秒'
      });
      
      // 达到最大重试次数，抛出最后一次错误
      if (retryCount >= CONFIG.VERIFY_RETRY_TIMES) {
        throw lastError;
      }
      
      // 等待重试间隔
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_INTERVAL));
    }
  }
  
  throw lastError;
};

/**
 * 提取 DNS TXT 验证记录
 * 最终版：精准适配中文日期格式的 acme.sh 输出
 * @param {Request} req - Express 请求对象
 * @param {string} output - acme.sh 命令输出
 * @returns {object} { txt_domain, txt_value }
 */
const extractTxtRecord = (req, output) => {
  // 调试：打印原始输出
  logger.debug(`开始提取 TXT 记录（中文日期格式适配）`, {
    requestId: req.requestId,
    outputPreview: output.substring(0, 1000)
  });

  // 精准匹配你的 acme.sh 输出格式：
  // [2026年 02月 27日 星期五 20:17:46 CST] Domain: '_acme-challenge.7x0.cn'
  // [2026年 02月 27日 星期五 20:17:46 CST] TXT value: 'EUq7UXkkqiCaYb4uNjNY0yMzf7D_cuMCEvgk3CFzQIQ'
  const regex = /\[.*年.*月.*日.*\]\s*Domain:\s*'_acme-challenge\.([^']+)'[\s\S]*?\[.*年.*月.*日.*\]\s*TXT value:\s*'([^']+)'/;
  
  // 第一次匹配（精准匹配中文日期格式）
  let matches = output.match(regex);
  
  if (matches && matches.length >= 3) {
    const result = {
      txt_domain: `_acme-challenge.${matches[1].trim()}`,
      txt_value: matches[2].trim()
    };
    logger.info(`提取 TXT 记录成功（中文日期格式）`, {
      requestId: req.requestId,
      ...result
    });
    return result;
  }

  // 备用匹配（兼容所有格式）
  logger.debug(`中文日期正则匹配失败，尝试通用匹配`, { requestId: req.requestId });
  const universalRegex = /Domain:\s*['"]?(_acme-challenge\.[^'"\s]+)['"]?.*?TXT value:\s*['"]?([^'"\s]+)['"]?/is;
  matches = output.match(universalRegex);
  
  if (matches && matches.length >= 3) {
    const result = {
      txt_domain: matches[1].trim(),
      txt_value: matches[2].trim()
    };
    logger.info(`提取 TXT 记录成功（通用格式）`, {
      requestId: req.requestId,
      ...result
    });
    return result;
  }

  // 终极兜底：手动字符串截取
  logger.debug(`正则匹配全部失败，尝试手动截取`, { requestId: req.requestId });
  const domainStart = output.indexOf('Domain: \'_acme-challenge.');
  const valueStart = output.indexOf('TXT value: \'');
  
  if (domainStart > -1 && valueStart > -1) {
    // 提取域名
    const domainEnd = output.indexOf('\'', domainStart + 20);
    const txtDomain = output.substring(domainStart + 16, domainEnd).trim();
    // 提取值
    const valueEnd = output.indexOf('\'', valueStart + 11);
    const txtValue = output.substring(valueStart + 11, valueEnd).trim();
    
    if (txtDomain && txtValue) {
      const result = {
        txt_domain: txtDomain,
        txt_value: txtValue
      };
      logger.info(`提取 TXT 记录成功（手动截取）`, {
        requestId: req.requestId,
        ...result
      });
      return result;
    }
  }

  // 所有方法都失败
  const errorMsg = '无法从 acme.sh 输出中提取 TXT 验证记录';
  logger.error(errorMsg, {
    requestId: req.requestId,
    fullOutput: output
  });
  throw new Error(`${errorMsg}，请检查 acme.sh 输出格式`);
};

/**
 * 清理过期文件（验证文件、压缩包）
 */
const cleanExpiredFiles = async () => {
  try {
    const now = Date.now();
    const expireMs = CONFIG.EXPIRE_HOURS * 60 * 60 * 1000;
    logger.debug(`开始清理过期文件`, {
      expireHours: CONFIG.EXPIRE_HOURS,
      currentTime: new Date(now).toISOString()
    });

    // 清理验证文件
    let certFiles;
    try {
      certFiles = await fs.readdir(CONFIG.CERT_DIR);
    } catch (err) {
      logger.warn(`读取验证文件目录失败`, { dir: CONFIG.CERT_DIR, error: err.message });
      certFiles = [];
    }
    
    for (const file of certFiles) {
      if (file.endsWith('_verify.json')) {
        const filePath = path.join(CONFIG.CERT_DIR, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > expireMs) {
            await fs.unlink(filePath);
            logger.info(`清理过期验证文件`, { filePath, mtime: new Date(stats.mtimeMs).toISOString() });
          }
        } catch (err) {
          logger.warn(`清理验证文件失败`, { filePath, error: err.message });
        }
      }
    }

    // 清理压缩包
    let zipFiles;
    try {
      zipFiles = await fs.readdir(CONFIG.ZIP_DIR);
    } catch (err) {
      logger.warn(`读取压缩包目录失败`, { dir: CONFIG.ZIP_DIR, error: err.message });
      zipFiles = [];
    }
    
    for (const file of zipFiles) {
      if (file.endsWith('_cert.zip')) {
        const filePath = path.join(CONFIG.ZIP_DIR, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > expireMs) {
            await fs.unlink(filePath);
            logger.info(`清理过期压缩包`, { filePath, mtime: new Date(stats.mtimeMs).toISOString() });
          }
        } catch (err) {
          logger.warn(`清理压缩包失败`, { filePath, error: err.message });
        }
      }
    }

    logger.debug(`过期文件清理完成`);
  } catch (err) {
    logger.error(`清理过期文件任务失败`, { error: err.message, stack: err.stack });
  }
};

// ======================== 核心接口 ========================

/**
 * 接口1：创建 DNS 验证记录
 * POST /api?action=create
 * Body: { domain: "7x0.cn" }
 */
app.post('/api', async (req, res) => {
  const reqId = req.requestId;
  try {
    logger.info(`处理创建验证记录请求`, { requestId: reqId });

    // 1. 解析参数
    const { action = 'create' } = req.query;
    const { domain } = req.body;
    const actualDomain = domain || req.query.domain || '';

    // 2. 参数校验
    if (action !== 'create') {
      return response(req, res, 400, '无效的操作类型', {
        allowed_actions: ['create'],
        received_action: action
      });
    }

    if (!actualDomain) {
      return response(req, res, 400, '域名参数不能为空', {
        tip: '请在请求体或查询参数中传入 domain 字段'
      });
    }

    // 严格的域名格式校验（防止命令注入）
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!domainRegex.test(actualDomain)) {
      return response(req, res, 400, '域名格式不正确', {
        tip: '仅支持字母、数字、-、.，且不能以-开头/结尾，每个段最长63字符',
        received_domain: actualDomain
      });
    }

    // 3. 检查 acme.sh
    checkAcmeSh();

    // 4. 执行 acme.sh 生成验证记录
    const args = [
      '--issue',
      '-d', actualDomain,
      '--dns', 'dns_manual',
      '--yes-I-know-dns-manual-mode-enough-go-ahead-please'
    ];
    const output = await executeAcmeShCommand(req, args);

    // 5. 提取 TXT 记录（适配中文日期格式）
    const { txt_domain, txt_value } = extractTxtRecord(req, output);

    // 6. 保存验证信息
    const verifyData = {
      domain: actualDomain,
      txt_domain,
      txt_value,
      create_time: Date.now(),
      request_id: reqId
    };
    const verifyFile = path.join(CONFIG.CERT_DIR, `${actualDomain}_verify.json`);
    await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), { mode: 0o644 });
    logger.info(`保存验证信息成功`, { requestId: reqId, verifyFile });

    // 7. 构建验证 URL
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    const verifyUrl = `${protocol}://${req.headers.host}/api?action=verify&domain=${encodeURIComponent(actualDomain)}`;

    // 8. 返回结果
    response(req, res, 200, 'DNS 验证记录生成成功', {
      txt_domain,
      txt_value,
      verify_url: verifyUrl,
      tips: [
        '1. 请在域名解析后台添加 TXT 记录，主机记录为 _acme-challenge（无需加域名）',
        '2. 添加后建议等待5-10分钟再验证（DNS 生效需要时间）',
        '3. 验证记录有效期24小时，超时需重新生成',
        '4. "Cannot find DNS API hook for: dns_manual" 是正常提示，无需处理',
        '5. 验证前请用命令验证 TXT 记录是否生效：nslookup -type=TXT ${txt_domain}'
      ]
    });
  } catch (err) {
    logger.error(`创建验证记录失败`, {
      requestId: reqId,
      error: err.message,
      stack: err.stack
    });
    response(req, res, 500, err.message, {
      request_id: reqId,
      debug_info: CONFIG.NODE_ENV === 'development' ? {
        stack: err.stack.substring(0, 500),
        full_error: err.message
      } : {}
    });
  }
});

/**
 * 接口2：验证 DNS 并生成证书 / 接口3：下载证书
 * GET /api?action=verify&domain=7x0.cn
 * GET /api?action=download&domain=7x0.cn&filename=xxx.zip
 */
app.get('/api', async (req, res) => {
  const reqId = req.requestId;
  const { action, domain, filename } = req.query;
  logger.info(`处理 GET 请求`, { requestId: reqId, action, domain });

  // 基础参数校验：域名不能为空
  if (!domain) {
    return response(req, res, 400, '域名参数不能为空', {
      tip: '请在查询参数中传入 domain 字段'
    });
  }

  // 严格的域名格式校验
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!domainRegex.test(domain)) {
    return response(req, res, 400, '域名格式不正确', {
      received_domain: domain
    });
  }

  try {
    if (action === 'verify') {
      // ========== 验证 DNS 并生成证书 ==========
      // 1. 检查验证信息是否存在
      const verifyFile = path.join(CONFIG.CERT_DIR, `${domain}_verify.json`);
      try {
        await fs.access(verifyFile);
      } catch {
        return response(req, res, 404, '未找到该域名的验证信息', {
          tip: '请先生成验证记录',
          domain
        });
      }

      // 2. 检查 acme.sh
      checkAcmeSh();

      // 3. 执行 renew 命令验证 DNS 并生成证书（带重试）
      const args = [
        '--renew',
        '-d', domain,
        '--dns', 'dns_manual',
        '--yes-I-know-dns-manual-mode-enough-go-ahead-please'
      ];
      const output = await executeWithRetry(req, args);

      // 4. 检查证书文件是否存在
      const certDir = path.join(CONFIG.CERT_STORAGE_DIR, domain);
      const certFiles = [
        `${domain}.cer`,
        `${domain}.key`,
        'fullchain.cer',
        'ca.cer'
      ];

      // 验证所有证书文件是否存在
      for (const file of certFiles) {
        const filePath = path.join(certDir, file);
        if (!fsSync.existsSync(filePath)) {
          //throw new Error(`证书文件不存在：${filePath}`);
          throw new Error(`证书文件不存在`);
        }
      }
      logger.info(`证书文件检查通过`, { requestId: reqId, certDir, certFiles });

      // 5. 读取证书内容（安全读取，避免 sudo）
      const certContents = {};
      for (const file of certFiles) {
        const filePath = path.join(certDir, file);
        try {
          // 优先用普通权限读取
          certContents[file] = await fs.readFile(filePath, 'utf8');
          logger.debug(`读取证书文件成功`, { requestId: reqId, filePath });
        } catch (readErr) {
          if (CONFIG.USE_SUDO) {
            // 普通权限失败，用 sudo 兜底
            logger.warn(`普通权限读取证书失败，尝试 sudo`, { 
              requestId: reqId, 
              filePath, 
              error: readErr.message 
            });
            const { stdout } = await execFileAsync('sudo', ['cat', filePath], { encoding: 'utf8' });
            certContents[file] = stdout;
          } else {
            throw new Error(`读取证书文件 ${file} 失败：${readErr.message}（请检查文件权限或启用 USE_SUDO）`);
          }
        }
      }

      // 6. 打包证书文件（带时间戳，避免覆盖）
      const timestamp = Date.now();
      const zipFileName = `${domain}_cert_${timestamp}.zip`;
      const zipFile = path.join(CONFIG.ZIP_DIR, zipFileName);
      
      // 先删除已存在的同名文件（防止冲突）
      try {
        await fs.access(zipFile);
        await fs.unlink(zipFile);
        logger.debug(`删除已存在的压缩包`, { requestId: reqId, zipFile });
      } catch {}

      // 创建压缩包
      const outputStream = fsSync.createWriteStream(zipFile, { mode: 0o644 });
      const archive = archiver('zip', { zlib: { level: 9 } });

      // 处理压缩错误
      archive.on('error', (err) => {
        outputStream.close();
        throw new Error(`压缩证书失败：${err.message}`);
      });

      // 管道流：将压缩内容写入文件
      archive.pipe(outputStream);

      // 添加证书文件到压缩包
      for (const [file, content] of Object.entries(certContents)) {
        archive.append(content, { name: file });
        logger.debug(`添加文件到压缩包`, { requestId: reqId, file });
      }

      // 完成压缩
      await archive.finalize();
      logger.debug(`压缩包生成完成`, { requestId: reqId, zipFile });

      // 等待流关闭
      await new Promise((resolve, reject) => {
        outputStream.on('close', resolve);
        outputStream.on('error', (err) => {
          reject(new Error(`压缩包写入失败：${err.message}`));
        });
      });

      // 7. 删除验证文件（验证完成，清理临时文件）
      await fs.unlink(verifyFile);
      logger.info(`删除验证文件`, { requestId: reqId, verifyFile });

      // 8. 构建下载 URL
      const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
      const downloadUrl = `${protocol}://${req.headers.host}/api?action=download&domain=${encodeURIComponent(domain)}&filename=${encodeURIComponent(zipFileName)}`;

      // 9. 返回结果
      response(req, res, 200, '证书生成并打包成功', {
        download_url: downloadUrl,
        cert_files: certFiles,
        zip_file: zipFileName,
        tips: [
          '1. 证书有效期通常为90天，请及时更新',
          '2. 压缩包将在24小时后自动清理，请及时下载',
          '3. 证书文件包含：域名证书、私钥、完整链证书、CA证书',
          '4. 建议定期备份证书文件，避免丢失'
        ]
      });

    } else if (action === 'download') {
      // ========== 下载证书 ==========
      // 校验文件名
      if (!filename) {
        return response(req, res, 400, '压缩包文件名不能为空', {
          tip: '请在查询参数中传入 filename 字段（验证接口返回的 zip_file）'
        });
      }

      // 安全校验文件名（防止路径遍历攻击）
      if (!filename.startsWith(`${domain}_cert_`) || !filename.endsWith('.zip')) {
        return response(req, res, 400, '无效的压缩包文件名', {
          received_filename: filename,
          expected_format: `${domain}_cert_<时间戳>.zip`
        });
      }

      const zipFile = path.join(CONFIG.ZIP_DIR, filename);
      
      // 检查文件是否存在
      try {
        await fs.access(zipFile);
      } catch {
        return response(req, res, 404, '证书压缩包不存在', {
          filename,
          tip: '压缩包可能已过期清理或文件名错误'
        });
      }

      // 获取文件信息
      const stats = await fs.stat(zipFile);
      logger.info(`准备下载证书压缩包`, {
        requestId: reqId,
        zipFile,
        fileSize: stats.size,
        mtime: stats.mtime
      });

      // 设置下载响应头
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      // 流式传输文件（避免内存溢出）
      const fileStream = fsSync.createReadStream(zipFile);
      fileStream.pipe(res);

      // 处理流错误
      fileStream.on('error', (err) => {
        logger.error(`下载证书失败`, {
          requestId: reqId,
          zipFile,
          error: err.message
        });
        if (!res.headersSent) {
          response(req, res, 500, '文件读取失败', { error: err.message });
        }
      });

      // 下载完成后记录日志
      fileStream.on('end', () => {
        logger.info(`证书下载完成`, {
          requestId: reqId,
          zipFile,
          fileSize: stats.size
        });
      });

    } else {
      // 无效操作
      response(req, res, 400, '无效的操作类型', {
        allowed_actions: ['verify', 'download'],
        received_action: action
      });
    }
  } catch (err) {
    logger.error(`验证/下载证书失败`, {
      requestId: reqId,
      error: err.message,
      stack: err.stack,
      domain
    });
    response(req, res, 500, err.message, {
      request_id: reqId,
      domain,
      debug_info: CONFIG.NODE_ENV === 'development' ? {
        stack: err.stack.substring(0, 500)
      } : {}
    });
  }
});

// ======================== 404 处理 ========================
app.use((req, res) => {
  logger.warn(`请求路径不存在`, {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl
  });
  response(req, res, 404, '接口不存在', {
    tip: '请检查请求路径和方法是否正确，支持的接口：POST /api、GET /api'
  });
});

// ======================== 全局错误处理中间件 ========================
app.use((err, req, res, next) => {
  const reqId = req.requestId || 'unknown';
  logger.error(`全局错误捕获`, {
    requestId: reqId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  // 生产环境隐藏敏感错误信息
  const errorMsg = CONFIG.NODE_ENV === 'development' ? err.message : '服务器内部错误';
  
  response(req, res, 500, errorMsg, {
    request_id: reqId,
    debug: CONFIG.NODE_ENV === 'development' ? {
      stack: err.stack.substring(0, 500),
      original_error: err.message
    } : {}
  });
});

// ======================== 启动服务 ========================
(async () => {
  try {
    // 1. 创建必要目录
    await Promise.all([
      createDirIfNotExist(CONFIG.CERT_DIR),
      createDirIfNotExist(CONFIG.ZIP_DIR),
      createDirIfNotExist(CONFIG.LOG_DIR)
    ]);

    // 2. 启动定时任务（每小时清理过期文件）
    const cleanJob = new CronJob('0 * * * *', cleanExpiredFiles);
    cleanJob.start();
    logger.info('过期文件清理定时任务已启动', { cron: '每小时整点执行' });

    // 3. 启动 HTTP 服务
    const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
      logger.info(`ACME 证书接口服务启动成功`, {
        port: CONFIG.PORT,
        env: CONFIG.NODE_ENV,
        acme_sh_path: CONFIG.ACME_SH_PATH,
        cors_whitelist: CONFIG.CORS_WHITELIST,
        verify_retry_times: CONFIG.VERIFY_RETRY_TIMES,
        retry_interval: CONFIG.RETRY_INTERVAL / 1000 + '秒'
      });
      console.log(`========================================`);
      console.log(`服务已启动：http://0.0.0.0:${CONFIG.PORT}/api`);
      console.log(`运行环境：${CONFIG.NODE_ENV}`);
      console.log(`验证重试次数：${CONFIG.VERIFY_RETRY_TIMES}次，重试间隔：${CONFIG.RETRY_INTERVAL / 1000}秒`);
      console.log(`========================================`);
    });

    // 4. 处理服务器错误
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`端口 ${CONFIG.PORT} 已被占用`, { error: err.message });
        console.error(`启动失败：端口 ${CONFIG.PORT} 已被占用，请更换端口或关闭占用进程`);
      } else {
        logger.error(`服务器启动错误`, { error: err.message, stack: err.stack });
        console.error(`启动失败：${err.message}`);
      }
      process.exit(1);
    });

    // 5. 优雅关闭服务
    const gracefulShutdown = (signal) => {
      logger.info(`收到 ${signal} 信号，开始优雅关闭服务`);
      // 停止定时任务
      cleanJob.stop();
      // 关闭 HTTP 服务器
      server.close(() => {
        logger.info(`HTTP 服务器已关闭`);
        process.exit(0);
      });
      // 超时强制退出
      setTimeout(() => {
        logger.error(`关闭超时，强制退出`);
        process.exit(1);
      }, 10000);
    };

    // 监听退出信号
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (err) {
    logger.error(`服务启动失败`, { error: err.message, stack: err.stack });
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  }
})();

// ======================== 全局异常捕获 ========================
process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常', {
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });
  // 生产环境优雅退出（避免进程僵死）
  if (CONFIG.NODE_ENV === 'production') {
    setTimeout(() => process.exit(1), 1000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝', {
    reason: reason?.message || reason,
    promise: promise.toString(),
    timestamp: new Date().toISOString()
  });
});

// 导出 app 用于测试
module.exports = app;