import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';

export function trackPoolDisconnect(pool:pg.Pool) {
  const connected=new Set<pg.PoolClient>();
  pool.on('connect',client=>{connected.add(client);});
  pool.on('remove',client=>{connected.delete(client);});
  return {
    pendingCount:()=>connected.size,
    async wait(admin:pg.Client,databaseName:string,{timeoutMs=2500,queryTimeoutMs=500,intervalMs=20}={}) {
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline) {
        const remaining=deadline-Date.now();
        // node-postgres supports per-query query_timeout at runtime; its
        // current QueryConfig declaration omits the field.
        const query={
          text:'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
          values:[databaseName],
          query_timeout:Math.max(1,Math.min(queryTimeoutMs,remaining)),
        } as pg.QueryConfig&{query_timeout:number};
        const backends=Number((await admin.query<{count:number}>(query)).rows[0]?.count);
        if(connected.size===0&&backends===0)return true;
        await delay(Math.min(intervalMs,Math.max(1,deadline-Date.now())));
      }
      return false;
    },
  };
}
