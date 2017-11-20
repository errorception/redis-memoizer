const crypto = require('crypto');
const { promisify } = require('util');

const hash = string => crypto.createHmac('sha1', 'memo').update(string).digest('hex');

const openedPromise = () => {
  const opened = {};
  opened.promise = new Promise((resolve, reject) => {
    opened.resolve = resolve;
    opened.reject = reject;
  });

  return opened;
}

module.exports = client => {
  const redisGet = promisify(client.get).bind(client);
  const redisPsetex = promisify(client.psetex).bind(client);

  const getKeyFromRedis = async (ns, key) => {
    return JSON.parse(await redisGet(`memos:${ns}:${key}`));
  }

  const writeKeyToRedis = async (ns, key, value, ttl) => {
    if(ttl === 0) return;
    return redisPsetex(`memos:${ns}:${key}`, ttl, JSON.stringify(value));
  }

  return function memoize(fn, { ttl = 120000, name } = {}) {
    if(!name) throw new Error('You must provide a options.name for the function to memoize.');

    const inFlight = {};
    const ttlfn = typeof ttl === 'function' ? ttl : () => ttl;
    
    const memoizedFunction = async function(...args) {
      const argsStringified = hash(JSON.stringify(args));

      const redisCacheValue = await getKeyFromRedis(name, argsStringified);
      if(redisCacheValue) return redisCacheValue;

      const p = openedPromise();

      if(inFlight[argsStringified]) {
        inFlight[argsStringified].push(p);
        return p.promise;
      }
      
      inFlight[argsStringified] = [p];
      
      fn.apply(this, args).then(result => {
        writeKeyToRedis(name, argsStringified, result || null, ttlfn(result));
        (inFlight[argsStringified] || []).forEach(p => p.resolve(result));
        delete inFlight[argsStringified];
      }).catch(e => {
        (inFlight[argsStringified] || []).forEach(p => p.reject(e));
        delete inFlight[argsStringified];
      });

      return p.promise;
    }

    return memoizedFunction;
  }
};
