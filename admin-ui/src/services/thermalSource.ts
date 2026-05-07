/**
 * 811C 熱像 SSE 客戶端（M-PM-107 軌 1 frontend 遷移；M-PM-158 multi-edge fan-in 校正）
 *
 * 老王 5/7 chat 設計校正：
 *   - 「811C 不要綁死在某一顆 Edge 上面」 — IR 設備可漂移（搬到別 Edge）；UI 不認 edge_id
 *   - 「存活判定認 MAC + 安裝位置標籤」 — device_id（MAC）為主鍵；display_name 為人讀辨識
 *
 * 設計（M-PM-158 multi-edge fan-in）：
 *   - 同時連多個 Edge SSE（透過 connectMulti(baseUrls)）
 *   - 所有 frame 統一聚合，listener 不知 frame 來自哪個 Edge
 *   - device_id（MAC）為主鍵索引；frame 從哪 Edge 推不影響顯示
 *   - CORS 已驗 ACAO=* (M-PM-158 §2.3)；admin-ui 從 Tailscale/LAN 直連 Edge LAN OK
 *   - nginx /stream/811c proxy 保留 backcompat 但本層不依賴
 */

export type ThermalFrame = {
  device_id: string;
  ts: string;
  macno: string;
  model: string;
  irdata: string;
  shift: string;
  image?: string;
};

type FrameListener = (frame: ThermalFrame) => void;

export class ThermalSSEClient {
  /**
   * Map<baseUrl, EventSource>
   * Multi-edge fan-in：同時 connect 多個 Edge SSE；所有 frame 聚合進同一 listener pipeline
   */
  private connections: Map<string, EventSource> = new Map();
  private listeners = new Set<FrameListener>();
  private connectedCount = 0;

  /** 連接多個 SSE endpoint（multi-edge fan-in；M-PM-158 主入口）*/
  connectMulti(baseUrls: string[]): void {
    // diff：只 disconnect 不再需要的；新加缺少的；保留既有的
    const targetUrls = new Set(baseUrls.filter(Boolean));

    // 移除不再需要的
    for (const [url, es] of this.connections) {
      if (!targetUrls.has(url)) {
        es.close();
        this.connections.delete(url);
        // eslint-disable-next-line no-console
        console.log('[ThermalSSE] disconnected', url);
      }
    }

    // 新增缺少的
    for (const baseUrl of targetUrls) {
      if (this.connections.has(baseUrl)) continue;
      this.openOne(baseUrl);
    }

    this.recountConnected();
  }

  /** 單 Edge connect (backward compat for 既有調用) */
  connect(baseUrl: string): void {
    this.connectMulti([baseUrl]);
  }

  private openOne(baseUrl: string): void {
    const url = `${baseUrl}/stream/811c`;
    const es = new EventSource(url);

    es.addEventListener('frame', (evt) => {
      try {
        const frame: ThermalFrame = JSON.parse((evt as MessageEvent).data);
        this.listeners.forEach((fn) => fn(frame));
      } catch {
        // eslint-disable-next-line no-console
        console.warn('[ThermalSSE] failed to parse frame:', (evt as MessageEvent).data?.slice(0, 100));
      }
    });

    es.onopen = () => {
      // eslint-disable-next-line no-console
      console.log('[ThermalSSE] connected to', url);
      this.recountConnected();
    };

    es.onerror = () => {
      // EventSource 會自動重連；只更新 connected count
      this.recountConnected();
    };

    this.connections.set(baseUrl, es);
  }

  private recountConnected(): void {
    let n = 0;
    for (const es of this.connections.values()) {
      // EventSource.OPEN === 1
      if (es.readyState === 1) n++;
    }
    this.connectedCount = n;
  }

  /** 斷開所有連線 */
  disconnect(): void {
    for (const es of this.connections.values()) es.close();
    this.connections.clear();
    this.connectedCount = 0;
  }

  /** 訂閱 frame 事件，回傳 unsubscribe function */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 至少一條 SSE 連線即視為「已連線」*/
  get isConnected(): boolean {
    this.recountConnected();
    return this.connectedCount > 0;
  }

  /** 當前活躍連線數（multi-edge 用；UI 顯示「N/M 條 SSE」可用） */
  get activeConnectionCount(): number {
    this.recountConnected();
    return this.connectedCount;
  }

  /** 當前嘗試連線總數 */
  get totalConnectionCount(): number {
    return this.connections.size;
  }
}

/** 全域單例 */
export const thermalSSEClient = new ThermalSSEClient();
