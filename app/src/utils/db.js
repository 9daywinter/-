// v2 单机版数据层：db-core 的 uni storage 适配。
// 小程序云端模式见 cloudfunctions/api（同一套 db-core 逻辑，云 KV 适配）。
import { bindStorage, localRequest, exportAll, importAll, importTimetable } from "./db-core";

bindStorage({
  get: (k) => uni.getStorageSync(k),
  set: (k, v) => uni.setStorageSync(k, v),
});

export { localRequest, exportAll, importAll, importTimetable };
