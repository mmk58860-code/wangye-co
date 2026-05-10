const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Bucket {
  constructor(rate) {
    this.rate = Math.max(1, Number(rate || 1));
    this.tokens = this.rate;
    this.updated = Date.now();
  }

  setRate(rate) {
    this.rate = Math.max(1, Number(rate || 1));
    this.tokens = Math.min(this.tokens, this.rate);
  }

  async take() {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.updated) / 1000;
      this.updated = now;
      this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(20, Math.ceil(((1 - this.tokens) / this.rate) * 1000)));
    }
  }
}

export class RateLimiter {
  constructor(rate) {
    this.bucket = new Bucket(rate);
  }

  setRate(rate) {
    this.bucket.setRate(rate);
  }

  take() {
    return this.bucket.take();
  }
}
