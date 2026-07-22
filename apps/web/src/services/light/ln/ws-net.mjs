// @ts-nocheck — LDK-биндинги нетипизированы под tsc (.res живёт на подклассах Result, wasm-ассет ?url); корректность закрыта step9-стендом
// ws-net.mjs — LDK SocketDescriptor поверх СТАНДАРТНОГО WebSocket. Ни одного node-импорта:
// только WebSocket + Uint8Array, то есть этот файл без изменений работает в браузере/воркере.
// LN-узел (LND/LSP) слушает TCP — между ними наш ws↔tcp мост (services/p2p-bridge), тот же
// паттерн, каким кошелёк уже говорит с freicoind.
import * as ldk from 'lightningdevkit';

export class WsLDKNet {
  constructor(peer_manager) { this.peer_manager = peer_manager; this.count = 0n; }

  /** Исходящее подключение к пиру через ws-мост. Резолвится после установления сокета
   *  (LN-рукопожатие докатывается асинхронно через read_event/process_events). */
  async connect_peer(wsUrl, peer_node_id) {
    const pm = this.peer_manager;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      ws.onopen = () => res(null);
      ws.onerror = () => rej(new Error('ws connect failed: ' + wsUrl));
    });
    const idx = this.count++;
    const descriptor = ldk.SocketDescriptor.new_impl({
      // WebSocket не даёт настоящего backpressure-API — принимаем всё и полагаемся на
      // bufferedAmount браузера; для одного LSP-канала это заведомо достаточно
      send_data(data, _resume_read) { try { ws.send(data); } catch { return 0; } return data.length; },
      disconnect_socket() { try { ws.close(); } catch {} },
      eq(other) { return other.hash() == this.hash(); },
      hash() { return idx; },
    });
    ws.onmessage = ev => {
      const res = pm.read_event(descriptor, new Uint8Array(ev.data));
      if (!res.is_ok()) descriptor.disconnect_socket();
      pm.process_events();
    };
    ws.onclose = () => { try { pm.socket_disconnected(descriptor); } catch {} };
    const res = pm.new_outbound_connection(peer_node_id, descriptor, ldk.Option_SocketAddressZ.constructor_none());
    if (!res.is_ok()) { descriptor.disconnect_socket(); throw new Error('new_outbound_connection failed'); }
    descriptor.send_data(res.res, true);
    pm.process_events();
    return descriptor;
  }
}
