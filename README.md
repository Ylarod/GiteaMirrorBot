# Gitea Mirror Bot (Cloudflare Workers + Telegram)

## 功能概述
- Telegram 机器人，支持将 GitHub/任意 Git 源仓库镜像到你的 Gitea。

## 指令
- `/getid`：获取你的 Telegram userId（无需登录）
- `/login <GITHUB_TOKEN>`：保存你在 KV 中的 GitHub Token（可选组织校验）
- `/logout`：清除你在 KV 中保存的 GitHub Token
- `/mirror <Git URL> <目标org/repo>`：从任意 Git 源镜像到指定 Gitea 组织/仓库
- `/mirror <GitHub URL> [目标org/repo]`：从 GitHub 仓库/用户镜像（支持批量用户仓库）

## 权限与存储

- KV 命名空间：`GITEA_MIRROR_BOT`，仅保存 `userId -> githubToken`（纯字符串）
- `OWNER_ID`：仅 OWNER 可使用环境中的 `GITHUB_TOKEN`；非 OWNER 必须先 `/login` 才能 `/mirror`
- `GITHUB_AUTH_ORG`（可选）：若设置，`/login` 时会校验该 token 的用户是否为该组织成员
- 迁移 GitHub 源：调用 Gitea `POST /api/v1/repos/migrate`，附带 `auth_token` 且 `service: "github"`

## 部署

### 创建并绑定 KV

```
wrangler kv namespace create GITEA_MIRROR_BOT
```
将返回的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces`（不使用 `preview_id`）。

### 部署 Worker

```
wrangler deploy
```

## 环境变量与 Secrets（全部通过 secrets 配置）

### 必需

- `BOT_TOKEN`：Telegram 机器人 Token
- `GITEA_BASE`：Gitea 基址（如 `https://gitea.example.com`）
- `GITEA_TOKEN`：Gitea 访问 Token（有迁移/建组织权限）
- `GITEA_USERNAME`：Gitea 登录用户名（用于跳过自有空间的组织创建）
- `OWNER_ID`：Telegram 用户 ID（字符串），仅该用户可使用环境中的 `GITHUB_TOKEN`

### 可选

- `GITHUB_AUTH_ORG`：限制 `/login` 用户必须属于此 GitHub 组织
- `GITHUB_TOKEN`：供 OWNER 使用的 GitHub Token（其他用户无权使用）
- Cloudflare Access（直传服务令牌，不置换 JWT）：
  - `CF_ACCESS_CLIENT_ID`
  - `CF_ACCESS_CLIENT_SECRET`

### 设置 secrets（示例）

```
wrangler secret put BOT_TOKEN
wrangler secret put GITEA_BASE
wrangler secret put GITEA_TOKEN
wrangler secret put GITEA_USERNAME
wrangler secret put OWNER_ID
# 可选
wrangler secret put GITHUB_AUTH_ORG
wrangler secret put GITHUB_TOKEN
wrangler secret put TELEGRAM_SECRET_TOKEN
```

## Telegram Webhook 配置

使用仓库中的脚本设置/查看 Webhook：

- 用法
```
./set_webhook <BOT_TOKEN> [WEBHOOK_URL] [SECRET_TOKEN]
```

- 示例
```
# 方式一：显式传 URL
./set_webhook <你的BOT_TOKEN> https://<你的-worker-域名>

# 方式二：用环境变量传 URL
chmod +x ./set_webhook
WEBHOOK_URL=https://<你的-worker-域名> TELEGRAM_SECRET_TOKEN=<你的SECRET> ./set_webhook <你的BOT_TOKEN>

# 取消 Webhook（置空 URL）
./set_webhook <你的BOT_TOKEN> ""
```

脚本会在设置后自动调用 getWebhookInfo 回显当前状态。若设置了 SECRET_TOKEN，则 Telegram 会在回调请求头 `X-Telegram-Bot-Api-Secret-Token` 中附带该值，Worker 将与 `TELEGRAM_SECRET_TOKEN` 对比校验，失败返回 401。
脚本默认将 `allowed_updates` 设置为 `["message"]` 以限制仅接收消息更新。

## 使用示例

- 获取个人 ID：`/getid`
- 非 OWNER 登录：`/login ghp_xxx...`（若配置了 `GITHUB_AUTH_ORG` 会先校验组织成员）
- 镜像 GitHub 仓库：`/mirror https://github.com/owner/repo`
- 镜像 GitHub 用户全部仓库：`/mirror https://github.com/owner [target-org]`
- 镜像任意 Git 源：`/mirror https://git.host/org/repo.git targetOrg/repo`
- 退出并清除凭据：`/logout`

## 故障排查

- 提示未绑定 KV：检查 `wrangler.jsonc` 的 `kv_namespaces` 是否包含 `GITEA_MIRROR_BOT` 且 `id` 正确。
- 提示缺少 Gitea 配置：确认相应 secrets 已设置（`GITEA_BASE`/`GITEA_TOKEN`/`GITEA_USERNAME`）。
- 非 OWNER 未登录时被拒绝：先 `/login <GITHUB_TOKEN>`。
- GitHub 组织校验失败：确认 token 有权限访问组织信息，且确为组织成员（`/login` 会提示原因）。
- 访问 Gitea 被阻止（403/302）：
  - 若启用 Zero Trust，请确认 `CF_ACCESS_CLIENT_ID/SECRET` secrets 已正确配置；

## 注意

本项目不使用 `vars`，所有敏感配置均通过 `wrangler secret` 管理。
