package config

import "time"

// Limits are the confirmed configurable input and media boundaries shared with the browser.
type Limits struct {
	PasswordMin     int   `yaml:"password_min" json:"password_min"`           // Minimum password Unicode code points.
	PasswordMax     int   `yaml:"password_max" json:"password_max"`           // Maximum password Unicode code points.
	NameMax         int   `yaml:"name_max" json:"name_max"`                   // Maximum name code points.
	TextMax         int   `yaml:"text_max" json:"text_max"`                   // Maximum record text code points.
	MessageMax      int   `yaml:"message_max" json:"message_max"`             // Maximum family-message code points.
	RewardMax       int64 `yaml:"reward_max" json:"reward_max"`               // Maximum reward in either currency.
	PriceMax        int64 `yaml:"price_max" json:"price_max"`                 // Maximum price in either currency.
	StockMax        int64 `yaml:"stock_max" json:"stock_max"`                 // Maximum finite stock.
	DailyLimitMax   int64 `yaml:"daily_limit_max" json:"daily_limit_max"`     // Maximum completions per task per day.
	ListDaysMax     int   `yaml:"list_days_max" json:"list_days_max"`         // Maximum inclusive listing span.
	StatsDaysMax    int   `yaml:"stats_days_max" json:"stats_days_max"`       // Maximum inclusive statistics span.
	PhotoBytesMax   int64 `yaml:"photo_bytes_max" json:"photo_bytes_max"`     // Maximum uploaded photograph bytes.
	PhotoPixelsMax  int64 `yaml:"photo_pixels_max" json:"photo_pixels_max"`   // Maximum decoded photograph pixels.
	PhotoEdgeMax    int   `yaml:"photo_edge_max" json:"photo_edge_max"`       // Longest re-encoded image edge.
	AudioBytesMax   int64 `yaml:"audio_bytes_max" json:"audio_bytes_max"`     // Maximum uploaded recording bytes.
	AudioSecondsMax int   `yaml:"audio_seconds_max" json:"audio_seconds_max"` // Maximum actual recording duration.
}

// Defaults preserves existing configuration files while making every new limit explicit.
func Defaults() Config {
	zone, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		panic(err)
	}
	return Config{PublicOrigin: "http://127.0.0.1:5173", StaticDirectory: "web/dist", AssetsDirectory: ".local/assets", SessionTTL: 7 * 24 * time.Hour, ManagementTTL: 30 * time.Minute, UploadTimeout: 90 * time.Second, MediaOrphanTTL: 24 * time.Hour, MediaCleanupInterval: time.Hour, Location: zone, Limits: Limits{PasswordMin: 10, PasswordMax: 128, NameMax: 40, TextMax: 2000, MessageMax: 500, RewardMax: 1000000, PriceMax: 1000000, StockMax: 1000000, DailyLimitMax: 1000, ListDaysMax: 31, StatsDaysMax: 366, PhotoBytesMax: 10 << 20, PhotoPixelsMax: 20000000, PhotoEdgeMax: 2560, AudioBytesMax: 10 << 20, AudioSecondsMax: 60}}
}
