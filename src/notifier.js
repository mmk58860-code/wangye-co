export class Notifier {
  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger;
  }

  async telegram(text) {
    const cfg = this.getConfig().telegram || {};
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return;
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML' })
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
    } catch (error) {
      this.logger.warn('Telegram 推送失败', { error: error.message });
    }
  }

  async alert(message, meta = {}) {
    this.logger.alert(message, meta);
    await this.telegram(`TAO 子网提醒\n${message}`);
  }
}
