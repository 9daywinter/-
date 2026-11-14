<template>
  <view class="page">
    <view class="card">
      <view class="row">
        <text class="label">学期名</text>
        <input v-model="form.name" placeholder="本学期" />
      </view>
      <view class="row">
        <text class="label">第一周周一</text>
        <picker mode="date" :value="form.start_monday" @change="(e) => (form.start_monday = e.detail.value)">
          <view class="val">{{ form.start_monday }} ▾</view>
        </picker>
      </view>
      <view class="row">
        <text class="label">总周数</text>
        <picker :range="weekRange" :value="form.total_weeks - weekRange[0]" @change="(e) => (form.total_weeks = weekRange[0] + e.detail.value)">
          <view class="val">{{ form.total_weeks }} 周 ▾</view>
        </picker>
      </view>
      <view class="tip">
        教学周从这个周一开始数：当天自动算出“现在是第几周”，单双周课程据此显隐。
      </view>
    </view>

    <button class="save" @click="save">保存</button>
  </view>
</template>

<script>
import { api } from "../../utils/api";

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default {
  data() {
    return {
      form: { name: "本学期", start_monday: todayStr(), total_weeks: 20 },
      weekRange: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
    };
  },
  methods: {
    async save() {
      try {
        const term = await api.put("/api/terms", this.form);
        uni.showToast({ title: `已是第 ${term.current_week} 教学周`, icon: "none" });
        setTimeout(() => uni.navigateBack(), 600);
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
  },
};
</script>

<style scoped>
.page {
  padding: 24rpx;
  max-width: 950px; /* 电脑端居中限宽 */
  margin: 0 auto;
  box-sizing: border-box;
}
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 12rpx 24rpx;
}
.row {
  display: flex;
  align-items: center;
  padding: 24rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.label {
  width: 180rpx;
  color: #6b7280;
  font-size: 28rpx;
  flex-shrink: 0;
}
.row input {
  flex: 1;
  font-size: 28rpx;
  min-width: 0;
}
.val {
  flex: 1;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  font-size: 26rpx;
}
.tip {
  padding: 20rpx 0;
  font-size: 22rpx;
  color: #b0b5c1;
}
.card-title {
  padding-top: 24rpx;
  font-size: 30rpx;
  font-weight: 600;
}
.code {
  flex: 1;
  font-size: 28rpx;
  color: #4f46e5;
  word-break: break-all;
}
.copy {
  color: #4f46e5;
  font-size: 24rpx;
  padding: 6rpx 16rpx;
  background: #eef2ff;
  border-radius: 999rpx;
  flex-shrink: 0;
}
.mini {
  flex-shrink: 0;
  margin: 0 0 0 12rpx;
  padding: 0 24rpx;
  height: 60rpx;
  line-height: 60rpx;
  font-size: 24rpx;
  color: #fff;
  background: #4f46e5;
  border-radius: 10rpx;
}
.mini::after {
  border: none;
}
.save {
  margin-top: 60rpx;
  background: #4f46e5;
  color: #fff;
  font-size: 30rpx;
  border-radius: 14rpx;
  height: 88rpx;
  line-height: 1;
  border: none;
}
.save::after {
  border: none;
}
</style>
