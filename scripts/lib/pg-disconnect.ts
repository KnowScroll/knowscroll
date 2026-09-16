import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';

export function trackPoolDisconnect(pool:pg.Pool) {
  const connected=new Set<pg.PoolClient>();
  pool.on('connect',client=>{connected.add(client);});
  pool.on('remove',client=>{connected.delete(client);});
  return {
    pendingCount:()=>connected.size,
    async wait(admin:pg.Client,databaseName:string,{timeoutMs=2500,intervalMs=20}={}) {
      const deadline=Date.now()+timeoutMs;
      const queryTimeoutMs=500,minimumQueryBudget=50;
      while(true) {
        const remaining=deadline-Date.now();
        if(remaining<minimumQueryBudget)return false;
        // node-postgres supports per-query query_timeout at runtime; its
        // current QueryConfig declaration omits the field.
        const query={
          text:'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
          values:[databaseName],
          query_timeout:Math.max(1,Math.min(queryTimeoutMs,remaining)),
        } as pg.QueryConfig&{query_timeout:number};
        let backends:number;
        try {backends=Number((await admin.query<{count:number}>(query)).rows[0]?.count);}
        catch(error) {
          if(error instanceof Error&&error.message==='Query read timeout'&&Date.now()>=deadline)return false;
          throw error;
        }
        if(connected.size===0&&backends===0)return true;
        const sleepBudget=deadline-Date.now();
        if(sleepBudget<minimumQueryBudget)return false;
        await delay(Math.min(intervalMs,sleepBudget-minimumQueryBudget));
      }
    },
  };
}
