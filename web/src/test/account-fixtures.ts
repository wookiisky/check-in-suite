// 账户协议测试夹具只用于测试，不参与正式初始化。
export const testSession = {
  account: { id: 1, username: 'island-e2e', display_name: '测试小朋友', version: 1, preferences: { music_enabled: false, effects_enabled: true, reduce_motion: false } },
  csrf_token: 'test-csrf-token', management_expires_at: null,
  server_now: '2026-10-29T04:00:00Z', today: '2026-10-29', timezone: 'Asia/Taipei',
  limits: { password_min: 10, password_max: 128, name_max: 40, text_max: 2000, message_max: 500, reward_max: 1000000, price_max: 1000000, stock_max: 1000000, daily_limit_max: 1000, list_days_max: 31, stats_days_max: 366, photo_bytes_max: 10485760, photo_pixels_max: 20000000, photo_edge_max: 2560, audio_bytes_max: 10485760, audio_seconds_max: 60 },
};
