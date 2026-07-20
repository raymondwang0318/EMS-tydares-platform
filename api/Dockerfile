FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# A1-B6：收斂為單 worker——v1_admin 的 in-memory TTL cache 以單進程為前提
# （多進程各持一份視圖分歧）；本站流量單 asyncio 進程綽綽有餘。
# 未來要擴 workers：先把 cache 移出 router（B 級 B7），勿直接改此數字。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
