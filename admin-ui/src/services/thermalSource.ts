/**
 * 811C 熱像 SSE 客戶端（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 *
 * 連接 Edge SSE endpoint（GET /stream/811c）接收即時 frame。
 * nginx port 8080 已 proxy /stream/811c → 192.168.10.180:8080（Pi）；同 origin baseUrl=''
 * 使用瀏覽器原生 EventSource API，內建自動重連。
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
  private es: EventSource | null = null;
  private listeners = new Set<FrameListener>();
  private _connected = false;

  /** 連接 SSE endpoint */
  connect(baseUrl: string, deviceFilter?: string): void {
    this.disconnect();
    const url = deviceFilter ? `${baseUrl}/stream/811c/${deviceFilter}` : `${baseUrl}/stream/811c`;

    this.es = new EventSource(url);

    this.es.addEventListener('frame', (evt) => {
      try {
        const frame: ThermalFrame = JSON.parse((evt as MessageEvent).data);
        this.listeners.forEach((fn) => fn(frame));
      } catch {
        // eslint-disable-next-line no-console
        console.warn('[ThermalSSE] failed to parse frame:', (evt as MessageEvent).data?.slice(0, 100));
      }
    });

    this.es.onopen = () => {
      this._connected = true;
      // eslint-disable-next-line no-console
      console.log('[ThermalSSE] connected to', url);
    };

    this.es.onerror = () => {
      this._connected = false;
      // EventSource 會自動重連，不需手動處理
    };
  }

  /** 斷開連線 */
  disconnect(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this._connected = false;
  }

  /** 訂閱 frame 事件，回傳 unsubscribe function */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get isConnected(): boolean {
    return this._connected;
  }
}

/** 全域單例 */
export const thermalSSEClient = new ThermalSSEClient();
