const crypto = require('crypto');
const redisLock = require('redis-lock');
const { promisify } = require('util');
const CircularJSON = require('circular-json');

const sha1 = str => crypto.createHmac('sha1', 'memo').update(str).digest('hex');

const undefinedMarker = '__redis_memoizer_undefined';
const nullMarker = '__redis_memoizer_null';
const internalNotFoundInRedis = '__redis_memoizer_not_found';
const defaultTtl = 120000;

module.exports = client => {
  const redisGet = promisify(client.get).bind(client);
  const redisPsetex = promisify(client.psetex).bind(client);
  const lock = promisify(redisLock(client));

  const getResultFromRedis = async (ns, key) => {
    const valueFromRedis = await redisGet(`memos:${ns}:${key}`)

    if(valueFromRedis === null) return internalNotFoundInRedis;
    if(valueFromRedis === undefinedMarker) return undefined;
    if(valueFromRedis === nullMarker) return null;
    return JSON.parse(valueFromRedis);
  }

  const writeResultToRedis = async (ns, key, value, ttl) => {
    if(ttl === 0) return;

    let serializedValue;
    if(typeof value === 'undefined') {
      serializedValue = undefinedMarker;
    } else if(value === null) {
      serializedValue = nullMarker;
    } else {
      serializedValue = CircularJSON.stringify(value);
    }

    return redisPsetex(`memos:${ns}:${key}`, ttl, serializedValue);
  }

  return function memoize(fn, { ttl = defaultTtl, lockTimeout = 5000, name } = {}) {
    if(!name) throw new Error('You must provide a options.name for the function to memoize.');

    const ttlfn = typeof ttl === 'function' ? ttl : () => ttl;
    
    const memoizedFunction = async function(...args) {
      const argsStringified = sha1(JSON.stringify(args));

      // Return directly without locks if possible
      const redisCacheValue = await getResultFromRedis(name, argsStringified);
      if(redisCacheValue !== internalNotFoundInRedis) return redisCacheValue;

      // Lock ensures only one fn executes at a time.
      const unlock = await lock(sha1(`${name}:${argsStringified}`), lockTimeout);
      try {
        // Return from redis, if cache has been populated now
        const redisCacheRetry = await getResultFromRedis(name, argsStringified);
        if(redisCacheRetry !== internalNotFoundInRedis) return redisCacheRetry;

        const result = await fn.apply(this, args);
        const ttl = ttlfn(result);

        await writeResultToRedis(
          name,
          argsStringified,
          result,
          typeof ttl === 'number' ? ttl : defaultTtl
        );

        return result;
      } catch(e) {
        throw e;
      } finally {
        unlock();
      }
    };

    return memoizedFunction;
  }
};
