/**
 * 串行队列。
 *
 * 一个浏览器 profile 同时只允许一个流程操作页面 —— 两个发布流程并发会互相踩草稿。
 * 但也不能无限排队：调用方看到的会是「很慢」而不是「忙」，两者的处置完全不同，
 * 所以排队超过上限直接 BUSY，让调用方决定重试节奏。
 */
import { ToutiaoError } from '../errors.js';

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private active = false;

  constructor(private readonly max: number) {}

  get pending(): number {
    return this.waiting + (this.active ? 1 : 0);
  }

  async run<T>(task: () => Promise<T>, label = 'task'): Promise<T> {
    if (this.pending >= this.max) {
      throw new ToutiaoError(
        'BUSY',
        `当前有 ${this.pending} 个任务在排队（上限 ${this.max}）—— 同一账号的操作必须串行，请稍后重试`,
        { step: label, detail: { pending: this.pending, max: this.max } },
      );
    }

    this.waiting++;
    // 接在队尾：前一个无论成败都要放行下一个，所以 catch 掉再串
    const result = this.tail.then(
      () => {
        this.waiting--;
        this.active = true;
        return task();
      },
      () => {
        this.waiting--;
        this.active = true;
        return task();
      },
    );

    this.tail = result.then(
      () => {
        this.active = false;
      },
      () => {
        this.active = false;
      },
    );

    return result;
  }
}
