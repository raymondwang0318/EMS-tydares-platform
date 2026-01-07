# Central 錯誤碼規範（Edge 可直接對應行為）

| HTTP | error_code          | 意義               | Edge 行為                   |
| ---- | ------------------- | ---------------- | ------------------------- |
| 200  | -                   | stored/duplicate | 標記 sent                   |
| 400  | BAD_REQUEST         | payload 不合法      | 丟到 dead-letter（不重試）         |
| 401  | UNAUTHORIZED        | key/權限錯          | 停止上報 + 告警                 |
| 403  | FORBIDDEN           | 被禁止              | 停止上報 + 告警                 |
| 409  | CONFLICT            | 可用於去重衝突（可選）      | 視同 duplicate              |
| 413  | PAYLOAD_TOO_LARGE   | 太大               | 切分/壓縮/改走 media            |
| 429  | RATE_LIMIT          | 太頻繁              | 退避重試                      |
| 500  | SERVER_ERROR        | Central 內部錯      | 退避重試                      |
| 503  | SERVICE_UNAVAILABLE | 維護/忙碌            | 退避重試                      |
