/**
 * ADR-0021 phase-1 proof lane (#89). ADR-0020 says a lost or invalid submit/cancel response leaves
 * the caller in write-uncertain state: the server may have processed the request even though the
 * caller never saw its answer. This is a genuine transport failure of that shape, produced with a
 * real TCP proxy rather than simulated in the caller: the proxy forwards the client's request bytes
 * to the real target in full, then, once armed, severs the client connection the instant the
 * target's response begins to arrive — so the target really received and processed the request, and
 * the client really never receives the response.
 *
 * Plain Node (erasable TypeScript only): no enum/namespace/parameter-property syntax, so this file
 * can be run directly by `node` as well as by `tsx`.
 */
import { type AddressInfo, type Socket, connect, createServer } from 'node:net'

export interface DroppedConnection {
  id: number
  /** When this connection was accepted while the proxy was armed. */
  armedAt: number
  /** When the client socket was destroyed, just as the target's response began. */
  droppedAt: number
}

export interface LostResponseProxy {
  readonly port: number
  readonly origin: string
  /** Arms exactly the NEXT accepted connection to have its response dropped; single-shot. */
  arm(): void
  readonly dropped: readonly DroppedConnection[]
  close(): Promise<void>
}

export interface ProxyTarget {
  host: string
  port: number
}

/** A loopback TCP proxy in front of `target`, listening on `options.port` (0: OS-chosen). */
export function createLostResponseProxy(
  target: ProxyTarget,
  options: { port?: number } = {},
): Promise<LostResponseProxy> {
  return new Promise((resolve, reject) => {
    let armed = false
    let nextId = 0
    const dropped: DroppedConnection[] = []

    const server = createServer((client: Socket) => {
      const id = nextId
      nextId += 1
      const isArmed = armed
      armed = false // single-shot: arming affects only the next accepted connection

      const upstream = connect({ host: target.host, port: target.port })
      let settled = false

      const cleanup = () => {
        client.removeAllListeners()
        upstream.removeAllListeners()
      }
      client.on('error', () => {
        if (!upstream.destroyed) upstream.destroy()
      })
      upstream.on('error', () => {
        if (!client.destroyed) client.destroy()
      })

      // The request bytes are always forwarded in full, armed or not: the target must genuinely
      // receive and process them before any dropping decision is made.
      client.pipe(upstream)

      if (isArmed) {
        const armedAt = Date.now()
        upstream.once('data', () => {
          if (settled) return
          settled = true
          dropped.push({ id, armedAt, droppedAt: Date.now() })
          client.destroy()
          upstream.destroy()
          cleanup()
        })
        upstream.once('close', () => {
          if (!client.destroyed) client.destroy()
        })
      } else {
        upstream.pipe(client)
        client.once('close', () => {
          if (!upstream.destroyed) upstream.destroy()
        })
        upstream.once('close', () => {
          if (!client.destroyed) client.destroy()
        })
      }
    })

    server.on('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the lost-response proxy did not bind a TCP address'))
        return
      }
      const info = address as AddressInfo
      resolve({
        port: info.port,
        origin: `http://127.0.0.1:${info.port}`,
        arm() {
          armed = true
        },
        get dropped() {
          return dropped
        },
        close() {
          return new Promise<void>((res) => {
            server.close(() => res())
          })
        },
      })
    })
  })
}
