// L0 桩：L6 用真实实现替换整个文件（parseAnswer / handleLearningReply / applyLearning / applyConfirmed）。
// 签名已冻结，L5 现在就可以按这个签名接线；桩返回 0 = 没有可应用的条目。
export async function applyConfirmed(_e: { DB: any }, _groupId: string, _now?: number): Promise<number> {
  return 0;
}
