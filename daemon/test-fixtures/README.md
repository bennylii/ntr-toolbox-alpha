# test-fixtures —— 仅测试用

`localhost-cert.pem` / `localhost-key.pem`：**自签**测试证书（CN=localhost，SAN DNS:localhost + IP:127.0.0.1，10 年有效），
只被 `daemon/proxy-test.mjs` 用来起本地 HTTPS 目标，验证 CONNECT 隧道 + TLS 端到端。**不是任何真实服务的密钥**，
不要在测试之外使用。

重新生成（Git Bash）：

```sh
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 3650 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
