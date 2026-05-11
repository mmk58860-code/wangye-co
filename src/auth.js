import bcrypt from 'bcryptjs';

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: '未登录' });
}

export async function checkPassword(config, username, password) {
  if (!username || !password) return false;
  if (username !== config.auth.username) return false;
  return bcrypt.compare(password, config.auth.passwordHash);
}

export function publicConfig(config) {
  return {
    apiPool: {
      ...config.apiPool,
      keys: (config.apiPool.keys || []).map((key) => ({
        ...key,
        apiKey: key.apiKey ? mask(key.apiKey) : '',
        endpoint: key.endpoint ? maskEndpoint(key.endpoint) : ''
      }))
    },
    collector: config.collector,
    telegram: {
      enabled: config.telegram.enabled,
      botToken: config.telegram.botToken ? '******' : '',
      chatId: config.telegram.chatId || ''
    },
    github: config.github,
    auth: { username: config.auth.username }
  };
}

function mask(value) {
  if (value.length <= 8) return '******';
  return `${value.slice(0, 4)}******${value.slice(-4)}`;
}

function maskEndpoint(value) {
  return value.replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}
