import {
	createSSRApp
} from "vue";
import App from "./App.vue";
export function createApp() {
	// #ifdef MP-WEIXIN
	// 小程序线：初始化云开发（无闲日程表，免费体验环境）
	// 环境换了只改这里；H5/APK 线不受影响
	if (uni.cloud) {
		uni.cloud.init({ env: "cloud1-d4gqowt7sbcad53e0", traceUser: true });
	}
	// #endif
	const app = createSSRApp(App);
	return {
		app,
	};
}
