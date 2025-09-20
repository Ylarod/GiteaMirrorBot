export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Telegram Webhook OK", { status: 200 });
    }

    // 校验 Telegram Secret Token（若已配置）
    const expectedSecret = env.TELEGRAM_SECRET_TOKEN;
    if (expectedSecret) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!got || got !== expectedSecret) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    const update = await request.json();
    if (!update.message || !update.message.text) {
      return new Response("no message", { status: 200 });
    }

    const chatId = update.message.chat.id;
    const userId = (update.message.from && update.message.from.id) || chatId;
    const text = update.message.text.trim();

    try {
      if (text.startsWith("/mirror")) {
        await handleMirror(env, chatId, userId, text);
      } else if (text.startsWith("/getid")) {
        await handleGetId(env, chatId, userId, update);
      } else if (text.startsWith("/login")) {
        await handleLogin(env, chatId, userId, text, update);
      } else if (text.startsWith("/logout")) {
        await handleLogout(env, chatId, userId);
      } else {
        await sendMessage(
          env,
          chatId,
          [
            "可用命令:",
            "/login <GITHUB_TOKEN>",
            "/logout",
            "/mirror <Git URL> <目标org/repo>",
            "/mirror <GitHub URL> [目标org/repo]",
            "/getid",
          ].join("\n")
        );
      }
    } catch (e) {
      await sendMessage(env, chatId, "❌ 出错：" + e.message);
    }

    return new Response("ok", { status: 200 });
  },
};

// 会话依赖 Cloudflare KV: env.GITEA_MIRROR_BOT（仅在 KV 中保存 githubToken）

async function getSession(env, userKey) {
  const key = String(userKey);
  if (!env.GITEA_MIRROR_BOT || !env.GITEA_MIRROR_BOT.get) {
    throw new Error("未绑定 KV GITEA_MIRROR_BOT，请在 wrangler.jsonc 配置并部署");
  }
  const storedRaw = await env.GITEA_MIRROR_BOT.get(key); // 可能为明文或加密串
  const storedToken = storedRaw ? await decryptTokenIfNeeded(env, key, storedRaw) : "";
  // 若为明文且已配置加密盐，则自动迁移为加密格式
  const salt = env.AES_KEY_SALT || env["AES_KEY_SALT"];
  if (storedRaw && !storedRaw.startsWith("enc:v1:") && salt && storedToken) {
    try {
      const enc = await encryptTokenIfPossible(env, key, storedToken);
      if (enc && enc !== storedRaw) await env.GITEA_MIRROR_BOT.put(key, enc);
    } catch (_) {}
  }
  return {
    githubToken: storedToken || "",
    giteaBase: env.GITEA_BASE || "",
    giteaToken: env.GITEA_TOKEN || "",
    giteaUsername: env.GITEA_USERNAME || "",
  };
}

async function putSession(env, userKey, session) {
  const key = String(userKey);
  if (!env.GITEA_MIRROR_BOT || !env.GITEA_MIRROR_BOT.put) {
    throw new Error("未绑定 KV GITEA_MIRROR_BOT，请在 wrangler.jsonc 配置并部署");
  }
  // 仅保存 githubToken（AES 加密存储，缺失盐则回退明文）
  const toStore = await encryptTokenIfPossible(env, key, session.githubToken || "");
  await env.GITEA_MIRROR_BOT.put(key, toStore);
}

// ---- AES 加解密辅助（AES-GCM，key = SHA-256(AES_KEY_SALT + ':' + userId)）
async function encryptTokenIfPossible(env, userId, token) {
  const salt = env.AES_KEY_SALT || env["AES_KEY_SALT"];
  if (!salt || !token) return token;
  try {
    const key = await deriveAesKey(salt, userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(token)
    );
    const joined = new Uint8Array(iv.byteLength + enc.byteLength);
    joined.set(iv, 0);
    joined.set(new Uint8Array(enc), iv.byteLength);
    const b64 = bytesToBase64(joined);
    return `enc:v1:${b64}`;
  } catch (_) {
    return token; // 失败回退明文
  }
}

async function decryptTokenIfNeeded(env, userId, stored) {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored; // 明文兼容
  const salt = env.AES_KEY_SALT || env["AES_KEY_SALT"];
  if (!salt) return ""; // 无盐无法解密，安全起见返回空
  try {
    const b64 = stored.slice("enc:v1:".length);
    const bytes = base64ToBytes(b64);
    const iv = bytes.slice(0, 12);
    const cipher = bytes.slice(12);
    const key = await deriveAesKey(salt, userId);
    const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(dec);
  } catch (_) {
    return ""; // 解密失败当作无 token
  }
}

async function deriveAesKey(salt, userId) {
  const material = new TextEncoder().encode(`${salt}:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleMirror(env, chatId, userId, text) {
  const session = await getSession(env, userId);
  const ownerId = env.OWNER_ID && String(env.OWNER_ID);
  const isOwner = ownerId && String(userId) === ownerId;
  const effectiveGithubToken = session.githubToken || (isOwner ? (env.GITHUB_TOKEN || "") : "");

  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(env, chatId, "用法：\n- /mirror <Git URL> <目标org/repo>\n- /mirror <GitHub URL> [目标org/repo]");
    return;
  }

  if (!effectiveGithubToken) {
    await sendMessage(
      env,
      chatId,
      "未授权：请先 /login <GITHUB_TOKEN>；只有 OWNER 可使用环境变量中的 GitHub Token"
    );
    return;
  }

  const src = parts[1];
  const dst = parts[2] || null;

  const ghRepoMatch = src.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  const ghUserMatch = src.match(/^https:\/\/github\.com\/([^/]+)\/?$/);

  if (ghRepoMatch) {
    const srcOwner = ghRepoMatch[1];
    const srcRepo = ghRepoMatch[2];

    let dstOwner, dstRepo;
    if (dst) {
      const [o, r] = dst.split("/");
      dstOwner = o;
      dstRepo = r || srcRepo;
    } else {
      dstOwner = srcOwner;
      dstRepo = srcRepo;
    }

    await sendMessage(env, chatId, `开始镜像：${srcOwner}/${srcRepo} → ${dstOwner}/${dstRepo}`);
    await ensureOrg(env, session, dstOwner);
    await migrateRepo(env, session, dstOwner, dstRepo, `https://github.com/${srcOwner}/${srcRepo}.git`, effectiveGithubToken);
    await sendMessage(env, chatId, `✅ 镜像完成：${dstOwner}/${dstRepo}`);
  } else if (ghUserMatch) {
    const user = ghUserMatch[1];
    const dstOwner = dst || user;

    await sendMessage(env, chatId, `开始批量镜像 GitHub 用户 ${user} → Gitea:${dstOwner}`);
    await ensureOrg(env, session, dstOwner);
    const repos = await listGithubRepos(env, effectiveGithubToken, user);

    let ok = 0, fail = [];
    for (const repo of repos) {
      try {
        await migrateRepo(env, session, dstOwner, repo.name, repo.clone_url, effectiveGithubToken);
        ok++;
      } catch (e) {
        fail.push(`${repo.name}: ${e.message}`);
      }
    }

    let msg = `✅ 成功镜像 ${ok} 个仓库`;
    if (fail.length > 0) {
      msg += `\n⚠️ 失败 ${fail.length} 个:\n` + fail.slice(0, 10).join("\n");
    }
    await sendMessage(env, chatId, msg);
  } else {
    // 非 GitHub 的任意 Git 源地址：需要显式目标 org/repo
    if (!dst) {
      await sendMessage(env, chatId, "非 GitHub 地址必须指定目标：/mirror <Git URL> <目标org/repo>");
      return;
    }
    const [dstOwner, dstRepoRaw] = dst.split("/");
    if (!dstOwner || !dstRepoRaw) {
      await sendMessage(env, chatId, "目标格式不正确，应为：owner/repo");
      return;
    }
    const dstRepo = dstRepoRaw;

    await sendMessage(env, chatId, `开始镜像：${src} → ${dstOwner}/${dstRepo}`);
    await ensureOrg(env, session, dstOwner);
    await migrateRepo(env, session, dstOwner, dstRepo, src, effectiveGithubToken);
    await sendMessage(env, chatId, `✅ 镜像完成：${dstOwner}/${dstRepo}`);
  }
}

async function ensureOrg(env, session, owner) {
  const giteaBase = session.giteaBase || env.GITEA_BASE;
  const giteaToken = session.giteaToken || env.GITEA_TOKEN;
  const giteaUsername = session.giteaUsername || env.GITEA_USERNAME;
  if (!giteaBase || !giteaToken) throw new Error("缺少 Gitea 配置，请设置 GITEA_BASE/GITEA_TOKEN 或联系管理员");

  if (owner === giteaUsername) return; // 自己用户空间无需创建
  const resp = await fetch(`${giteaBase}/api/v1/orgs/${owner}`, {
    headers: giteaHeaders(env, session),
  });
  if (resp.status === 200) return;

  const create = await fetch(`${giteaBase}/api/v1/orgs`, {
    method: "POST",
    headers: giteaHeaders(env, session, true),
    body: JSON.stringify({ username: owner }),
  });
  if (!create.ok) {
    throw new Error(`创建组织失败: ${create.status}`);
  }
}

async function migrateRepo(env, session, dstOwner, dstRepo, srcUrl, githubToken) {
  const giteaBase = session.giteaBase || env.GITEA_BASE;
  const giteaToken = session.giteaToken || env.GITEA_TOKEN;
  if (!giteaBase || !giteaToken) throw new Error("缺少 Gitea 配置，请设置 GITEA_BASE/GITEA_TOKEN 或联系管理员");

  const body = {
    clone_addr: srcUrl,
    repo_name: dstRepo,
    repo_owner: dstOwner,
    mirror: true,
    private: false,
    service: "git",
  };
  // 若来源为 GitHub 且提供了 token，优先使用 Gitea 的 auth_token 字段
  if (/^https:\/\/github\.com\//i.test(srcUrl) && githubToken) {
    body.auth_token = githubToken;
    body.service = "github"; // 让 Gitea 以 GitHub 方式迁移
  }

  const resp = await fetch(`${giteaBase}/api/v1/repos/migrate`, {
    method: "POST",
    headers: giteaHeaders(env, session, true),
    body: JSON.stringify(body),
  });

  if (resp.status === 409 || resp.status === 422) {
    // 仓库已存在
    return;
  }

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`迁移失败: ${resp.status} ${txt}`);
  }
}

function giteaHeaders(env, session, withJson) {
  const token = (session && session.giteaToken) || env.GITEA_TOKEN;
  const headers = { Authorization: `token ${token}` };
  if (withJson) headers["Content-Type"] = "application/json";
  const cfId = env.CF_ACCESS_CLIENT_ID || env["CF-ACCESS-CLIENT-ID"];
  const cfSecret = env.CF_ACCESS_CLIENT_SECRET || env["CF-ACCESS-CLIENT-SECRET"];
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }
  return headers;
}

async function listGithubRepos(env, session, user) {
  let page = 1, result = [];
  while (true) {
    const url = `https://api.github.com/users/${user}/repos?per_page=100&page=${page}`;
    const headers = { "User-Agent": "cf-gitea-mirror-bot" };
    if (session) {
      // 兼容旧调用签名（若误传 session，则从中取 token）
      const tokenLegacy = session.githubToken;
      if (tokenLegacy) headers.Authorization = `token ${tokenLegacy}`;
    }
  
    // 新签名：当第二个参数是字符串 token 时
    if (typeof session === "string" && session) {
      headers.Authorization = `token ${session}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`GitHub API 错误 ${resp.status}`);
    const repos = await resp.json();
    if (repos.length === 0) break;
    result.push(...repos);
    page++;
    if (page > 20) break;
  }
  return result;
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function handleLogin(env, chatId, userId, text, update) {
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(env, chatId, "用法：/login <GITHUB_TOKEN>");
    return;
  }
  const token = parts[1];
  const requiredOrg = env.GITHUB_AUTH_ORG && String(env.GITHUB_AUTH_ORG).trim();
  if (requiredOrg) {
    try {
      const ok = await verifyGithubOrgMembership(requiredOrg, token);
      if (!ok) {
        await sendMessage(
          env,
          chatId,
          `❌ 无法登录：需要是 GitHub 组织 ${requiredOrg} 的成员（请确认已加入组织并为 token 授权读取组织信息）`
        );
        return;
      }
    } catch (e) {
      await sendMessage(env, chatId, `❌ 组织成员校验失败：${e.message}`);
      return;
    }
  }
  const session = await getSession(env, userId);
  session.githubToken = token;
  await putSession(env, userId, session);
  const extra = requiredOrg ? `（已通过组织 ${requiredOrg} 校验）` : "";
  await sendMessage(env, chatId, `✅ GitHub 登录成功，已保存 token（仅此用户可用）${extra}`);

  // 若存在 OWNER_ID，且当前登录者不是 OWNER，则通知 OWNER
  const ownerId = env.OWNER_ID && String(env.OWNER_ID);
  if (ownerId && String(userId) !== ownerId) {
    try {
      const from = update && update.message && update.message.from;
      const who = from && (from.username ? `@${from.username}` : from.first_name || "用户");
      let ghLine = "";
      try {
        const gh = await getGithubUser(token);
        if (gh) {
          const namePart = gh.name ? `（${gh.name}）` : "";
          ghLine = `\nGitHub: ${gh.login}${namePart}`;
        }
      } catch (_) {}
      const info = `🔔 登录通知\n${who ? `（${who}）` : ""}${ghLine}`;
      await sendMessage(env, ownerId, info);
    } catch (_) {
      // 忽略通知失败
    }
  }
}

async function getGithubUser(token) {
  if (!token) return null;
  const headers = {
    "User-Agent": "cf-gitea-mirror-bot",
    Accept: "application/vnd.github+json",
    Authorization: `token ${token}`,
  };
  const resp = await fetch("https://api.github.com/user", { headers });
  if (!resp.ok) return null;
  const data = await resp.json();
  return { login: data.login, name: data.name, id: data.id };
}

async function handleLogout(env, chatId, userId) {
  if (!env.GITEA_MIRROR_BOT || !env.GITEA_MIRROR_BOT.delete) {
    throw new Error("未绑定 KV GITEA_MIRROR_BOT，请在 wrangler.jsonc 配置并部署");
  }
  await env.GITEA_MIRROR_BOT.delete(String(userId));
  await sendMessage(env, chatId, "✅ 已退出并清除当前用户配置");
}

async function handleGetId(env, chatId, userId, update) {
  const from = update && update.message && update.message.from;
  const username = (from && (from.username || from.first_name)) || "";
  const chatType = update.message.chat && update.message.chat.type;
  const lines = [
    `你的 Telegram userId：${userId}`,
    `当前 chatId：${chatId}（类型：${chatType || "unknown"}）`,
  ];
  if (username) lines.unshift(`你好，${username}`);
  await sendMessage(env, chatId, lines.join("\n"));
}

async function verifyGithubOrgMembership(org, token) {
  const headers = {
    "User-Agent": "cf-gitea-mirror-bot",
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `token ${token}`;
  const url = `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`;
  const resp = await fetch(url, { headers });
  if (resp.status === 404) return false;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${txt}`);
  }
  const body = await resp.json();
  return body && body.state === "active";
}
