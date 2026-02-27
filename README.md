# SSL证书自助申请系统

## 项目概述

本项目是一个基于 Node.js 和 acme.sh 实现的 SSL 证书自助申请、验证和下载系统。通过提供 RESTful API 接口，实现了 DNS 手动解析验证方式的 SSL 证书全流程管理，包括证书申请、DNS 验证、证书生成和下载功能。

系统设计简洁高效，支持自动处理证书申请流程，为用户提供便捷的 SSL 证书管理服务。

## 系统架构

系统采用简洁的分层架构，主要包含以下组件：

1. **API 层**：基于 Express.js 构建的 RESTful API 接口，处理客户端请求
2. **业务逻辑层**：实现证书申请、验证和下载的核心逻辑
3. **工具层**：封装了 acme.sh 命令执行、文件操作、日志记录等功能
4. **存储层**：管理证书文件、验证信息和临时文件

## 核心功能

1. **证书申请**：通过 API 提交域名，生成 DNS TXT 验证记录
2. **DNS 验证**：用户添加 TXT 记录后，系统验证 DNS 解析是否生效
3. **证书生成**：验证通过后，生成 SSL 证书并打包
4. **证书下载**：提供证书压缩包下载功能
5. **自动清理**：定时清理过期的验证文件和压缩包
6. **日志记录**：详细的操作日志，便于问题排查

## 技术栈

| 技术/依赖       | 版本      | 用途                           |
|---------------|---------|-------------------------------|
| Node.js       | >= 16   | 运行环境                       |
| Express.js    | ^5.2.1  | Web 框架，提供 API 接口            |
| acme.sh       | 最新版    | 证书申请和管理工具              |
| archiver      | ^7.0.1  | 证书文件打包                   |
| cors          | ^2.8.6  | 跨域请求处理                   |
| cron          | ^4.4.0  | 定时任务管理                   |
| winston       | ^3.19.0 | 日志系统                       |
| uuid          | ^8.3.2  | 生成唯一标识符                  |

## 环境要求

- **操作系统**：Linux（推荐）/ Windows
- **Node.js**：v16.0.0 及以上版本
- **acme.sh**：已安装并配置
- **权限**：建议使用 root 用户运行，或配置 sudo 免密执行权限

## 安装步骤

### 1. 安装 acme.sh

```bash
# 安装 acme.sh
curl https://get.acme.sh | sh

# 验证安装
~/.acme.sh/acme.sh --version
```

### 2. 克隆项目

```bash
# 克隆项目到服务器
git clone https://gitee.com/byhandsome/nodesslapi

# 进入项目目录
cd /path/to/nodesslapi
```

### 3. 安装依赖

```bash
# 安装 Node.js 依赖
npm install
```

### 4. 配置 Nginx 反向代理

编辑 Nginx 配置文件，添加以下配置：

```nginx
location /api {
    proxy_pass http://127.0.0.1:3000/api;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_buffering on;
    proxy_buffer_size 16k;
    proxy_buffers 4 64k;
}
```

### 5. 启动服务

```bash
# 启动服务（后台运行）
nohup node app.js > app.log 2>&1 &

# 或使用进程管理工具（如 pm2）
npm install -g pm2
pm2 start app.js --name ssl-cert-api
```

## 配置说明

项目的主要配置项位于 `app.js` 文件中的 `CONFIG` 对象，可通过环境变量覆盖默认配置：

| 配置项 | 默认值 | 说明 |
|-------|-------|-----|
| PORT | 3000 | 服务端口 |
| ACME_SH_PATH | /home/.acme.sh/acme.sh | acme.sh 执行文件路径 |
| CERT_DIR | ./certs | 验证文件存储目录 |
| ZIP_DIR | ./zip | 证书压缩包存储目录 |
| LOG_DIR | ./logs | 日志文件存储目录 |
| CERT_STORAGE_DIR | /home/.acme.sh | acme.sh 证书存储目录 |
| EXPIRE_HOURS | 24 | 过期文件清理时间（小时） |
| CMD_TIMEOUT | 60000 | 命令执行超时（毫秒） |
| VERIFY_RETRY_TIMES | 3 | 验证重试次数 |
| RETRY_INTERVAL | 10000 | 重试间隔（毫秒） |
| CORS_WHITELIST | ['*'] | CORS 白名单 |
| USE_SUDO | true | 是否使用 sudo 执行命令 |
| NODE_ENV | production | 运行环境 |

## API 接口文档

### 1. 创建 DNS 验证记录

**请求**：
- 方法：POST
- 路径：/api
- 参数：action=create
- 请求体：`{"domain": "example.com"}`

**响应**：
```json
{
  "code": 200,
  "message": "DNS 验证记录生成成功",
  "data": {
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "txt_domain": "_acme-challenge.example.com",
    "txt_value": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "verify_url": "http://example.com/api?action=verify&domain=example.com",
    "tips": [
      "1. 请在域名解析后台添加 TXT 记录，主机记录为 _acme-challenge（无需加域名）",
      "2. 添加后建议等待5-10分钟再验证（DNS 生效需要时间）",
      "3. 验证记录有效期24小时，超时需重新生成",
      "4. \"Cannot find DNS API hook for: dns_manual\" 是正常提示，无需处理",
      "5. 验证前请用命令验证 TXT 记录是否生效：nslookup -type=TXT _acme-challenge.example.com"
    ]
  }
}
```

### 2. 验证 DNS 并生成证书

**请求**：
- 方法：GET
- 路径：/api?action=verify&domain=example.com

**响应**：
```json
{
  "code": 200,
  "message": "证书生成并打包成功",
  "data": {
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "download_url": "http://example.com/api?action=download&domain=example.com&filename=example.com_cert_1677777777777.zip",
    "cert_files": [
      "example.com.cer",
      "example.com.key",
      "fullchain.cer",
      "ca.cer"
    ],
    "zip_file": "example.com_cert_1677777777777.zip",
    "tips": [
      "1. 证书有效期通常为90天，请及时更新",
      "2. 压缩包将在24小时后自动清理，请及时下载",
      "3. 证书文件包含：域名证书、私钥、完整链证书、CA证书",
      "4. 建议定期备份证书文件，避免丢失"
    ]
  }
}
```

### 3. 下载证书

**请求**：
- 方法：GET
- 路径：/api?action=download&domain=example.com&filename=example.com_cert_1677777777777.zip

**响应**：
- 证书压缩包文件下载

## 使用流程

1. **申请证书**：调用 `create` 接口，获取 DNS TXT 验证记录
2. **添加 DNS 记录**：在域名解析后台添加获取到的 TXT 记录
3. **验证 DNS**：等待 5-10 分钟后，调用 `verify` 接口验证 DNS 记录
4. **下载证书**：验证通过后，使用返回的下载链接下载证书压缩包
5. **部署证书**：将证书部署到 Web 服务器（如 Nginx、Apache 等）

## 注意事项

1. **DNS 生效时间**：添加 TXT 记录后，需要等待 5-10 分钟让 DNS 解析生效
2. **权限问题**：建议使用 root 用户运行，或配置 sudo 免密执行权限
3. **安全配置**：生产环境中应修改 `CORS_WHITELIST` 为具体域名，避免使用 `*`
4. **证书有效期**：Let's Encrypt 证书有效期为 90 天，需要定期更新
5. **文件清理**：系统会自动清理 24 小时前的验证文件和压缩包
6. **错误处理**：如遇到错误，请查看日志文件（logs 目录）获取详细信息

## 故障排查

1. **acme.sh 命令执行失败**：检查 acme.sh 是否正确安装，路径是否配置正确
2. **DNS 验证失败**：确认 TXT 记录是否正确添加，DNS 解析是否生效
3. **证书文件不存在**：检查 acme.sh 证书存储目录权限，确认是否有读写权限
4. **端口被占用**：修改配置文件中的 PORT 值，或关闭占用端口的进程

## 许可证

本项目采用 MIT 许可证。

## 开发与维护

- **开发团队**：小七安全团队
- **版本**：v1.0
- **联系邮箱**：[751667278@qq.com]

---

**说明**：本服务为公益项目，请勿频繁请求或恶意请求。如有问题或建议，欢迎联系我们。