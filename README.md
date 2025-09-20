Gitea Mirror Bot (Cloudflare Workers + Telegram)

功能概述
- Telegram 机器人，支持将 GitHub/任意 Git 源仓库镜像到你的 Gitea。
- 指令：
  - `/getid`：获取你的 Telegram userId（无需登录）。
  - `/login <GITHUB_TOKEN>`：保存你在 KV 中的 GitHub Token（受可选组织校验）。
  - `/logout`：清除你在 KV 中保存的 GitHub Token。
  - `/mirror <Git URL> <目标org/repo>`：从任意 Git 源镜像到指定 Gitea 组织/仓库。
  - `/mirror <GitHub URL> [目标org/repo]`：从 GitHub 仓库/用户镜像（支持批量用户仓库）。

权限与安全
- KV 命名空间：`GITEA_MIRROR_BOT`，仅保存 `userId -> githubToken`（纯字符串）。
- `OWNER_ID`：仅 OWNER 可使用环境中的 `GITHUB_TOKEN`；非 OWNER 必须先 `/login` 才能 `/mirror`。
- `GITHUB_AUTH_ORG`（可选）：若设置，`/login` 时会校验该 token 的用户是否为该组织的成员，非成员拒绝登录。
- 迁移 GitHub 源时使用 Gitea `POST /api/v1/repos/migrate` 接口：自动携带 `auth_token` 并设置 `service: "github"`，支持私有仓库与更高的速率限制。

部署前置
- 需要 Cloudflare 账号与 wrangler。
- 已创建 KV 命名空间并绑定到 wrangler 配置：
  - `wrangler kv namespace create GITEA_MIRROR_BOT`
  - 将返回的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces`（不使用 `preview_id`）。

环境变量（全部通过 secrets 配置）
- 必需：
  - `BOT_TOKEN`：Telegram 机器人 Token
  - `GITEA_BASE`：Gitea 基址（如 `https://gitea.example.com`）
  - `GITEA_TOKEN`：Gitea 访问 Token（有迁移/建组织权限）
  - `GITEA_USERNAME`：Gitea 登录用户名（用于跳过自有空间的组织创建）
  - `OWNER_ID`：Telegram 用户 ID（字符串），仅该用户可使用环境中的 `GITHUB_TOKEN`
- 可选：
  - `GITHUB_AUTH_ORG`：限制 `/login` 用户必须属于此 GitHub 组织
  - `GITHUB_TOKEN`：供 OWNER 使用的 GitHub Token（其他用户无权使用）

设置 secrets（示例）
```
wrangler secret put BOT_TOKEN
wrangler secret put GITEA_BASE
wrangler secret put GITEA_TOKEN
wrangler secret put GITEA_USERNAME
wrangler secret put OWNER_ID
# 可选
wrangler secret put GITHUB_AUTH_ORG
wrangler secret put GITHUB_TOKEN
```

部署
```
wrangler deploy
```

Telegram Webhook 配置
- 将 Worker 部署地址设置为 Webhook：
```
curl -X POST "https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook" \
  -d url=https://<你的-worker-域名>
```

使用示例
- 获取个人 ID：`/getid`
- 非 OWNER 登录：`/login ghp_xxx...`（若配置了 `GITHUB_AUTH_ORG` 会先校验组织成员）
- 镜像 GitHub 仓库：`/mirror https://github.com/owner/repo`
- 镜像 GitHub 用户全部仓库：`/mirror https://github.com/owner [target-org]`
- 镜像任意 Git 源：`/mirror https://git.host/org/repo.git targetOrg/repo`
- 退出并清除凭据：`/logout`

故障排查
- 提示未绑定 KV：检查 `wrangler.jsonc` 的 `kv_namespaces` 是否包含 `GITEA_MIRROR_BOT` 且 `id` 正确。
- 提示缺少 Gitea 配置：确认相应 secrets 已设置（`GITEA_BASE`/`GITEA_TOKEN`/`GITEA_USERNAME`）。
- 非 OWNER 未登录时被拒绝：先 `/login <GITHUB_TOKEN>`。
- GitHub 组织校验失败：确认 token 有权限访问组织信息，且确为组织成员（`/login` 会提示原因）。

注意
- 本项目不使用 `vars`，所有敏感配置均通过 `wrangler secret` 管理。
