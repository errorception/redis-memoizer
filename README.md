redis-memoizer [![Build Status](https://travis-ci.org/errorception/redis-memoizer.svg?branch=master)](https://travis-ci.org/errorception/redis-memoizer)
===

An asynchronous function memoizer for node.js, using redis as the memo store. Memos expire after a specified timeout. Great as a drop-in performance optimization / caching layer for heavy asynchronous functions.

The current version (1.x) is designed to work with promises and async/await on node 8.x+. You might want to use the older version (0.x) if you want to work with the old callback style and with older versions of node (0.6+). See migration notes at the bottom of this readme.

Wikipedia [explains it best](http://en.wikipedia.org/wiki/Memoization):
> ...memoization is an optimization technique used primarily to speed up computer programs by having function calls avoid repeating the calculation of results for previously processed inputs.

```javascript
const redisClient = require('redis').createClient();
const memoize = require("redis-memoizer")(redisClient);

const expensiveOperation = async (arg1, arg2) => {
  // later...
  return result;
}

const memoizedExpensiveOperation = memoize(expensiveOperation, { name: 'expensiveOperation' });

const result = await memoizedExpensiveOperation(1, 2);
```

Or with promises:
```javascript
const expensiveOperation = (arg1, arg2) => {
  return new Promise((resolve, reject) => {
    // ...later
    resolve(result);
  });
}

const memoizedExpensiveOperation = memoize(expensiveOperation, { name: 'expensiveOperation' });

memoizedExpensiveOperation(1, 2).then(result => ...);

```

Now, calls to `memoizedExpensiveOperation` will have the same effect as calling `expensiveOperation`, except it will be much faster. The results of the first call are stored in redis and then looked up for subsequent calls.

Redis effectively serves as a shared network-available cache for function calls. The memoization cache is available across processes, so that if the same function call is made from different processes they will reuse the cache.

## Uses

Let's say you are making a DB call that's rather expensive. Let's say you've wrapped the call into a `getUserProfile` function that looks as follows:

```javascript
const getUserProfile = async userId => {
  // Go over to the DB, perform expensive call, get user's profile
  return userProfile;
}
```

Let's say this call takes a lot of resources (IO/CPU/RAM) to complete. You want to make it faster, and don't care about the fact that the value of `userProfile` might be slightly outdated (until the cache expires in redis). You could simply do the following:

```javascript
const memoizedGetUserProfile = memoize(getUserProfile, { name: 'getUserProfile' });

// First call. This will take some time.
let userProfile = await memoizedGetUserProfile('user1');

// Second call. This will be blazingly fast.
userProfile = await memoizedGetUserProfile('user1');
```

This can similarly be used for any network or disk bound async calls where you are tolerant of slightly outdated values.

## Usage

### Initialization
```javascript
const memoize = require("redis-memoizer")(redisClient);
```

Initializes the module with a redis client object, created by calling `.createConnection()` on the [node-redis](https://github.com/mranney/node_redis#rediscreateclientport-host-options) module.

### memoize(asyncFunction, options)

Memoizes an async function and returns it.

* `asyncFunction` must be an asynchronous function that needs to be memoized. The function must be an `AsyncFunction` (using the `async` keyword), or must return a promise.

* `options` must be an object with the following properties:
  * `name`: Required. A name for the function. This name is used in the key in redis. All function with this name will share the memo cache.
  * `ttl`: Default 120000. The amount of time in milliseconds for which the result of the function call should be cached in redis. Once the timeout is hit, the value is deleted from redis automatically. This is done using the redis [`psetex` command](http://redis.io/commands/psetex). The timeout is only set the first time, so the value expires after the timeout has expired since the first call. The timeout is not reset with every call to the memoized function. Once the value has expired in redis, this module will treat the function call as though it's called the first time again. `ttl` can alternatively be a function, if you want to dynamically determine the cache time based on the data returned. The returned data will be passed into the ttl function.

    ```javascript
    const httpCallMemoized = memoize(makeHttpCall, {
      name: 'makeHttpCall',
      ttl: res => {
        // return number of ms based on say response's 'expires' header
      }
    });

    const result = await httpCallMemoized(...);
    ```
  * `lockTimeout`: Default: 5000. The amount in time in milliseconds for the lock timeout. This is passed on to [redis-lock](https://github.com/errorception/redis-lock), which maintains a lock during the first call to prevent a cache stampede. Read the section below for details. The rule of thumb is that this time should be as high as the wort-case-scenario longest time it'll take to execute the function, but no higher.

## Cache Stampedes

This module does its best to minimize the effect of a [cache stampede](http://en.wikipedia.org/wiki/Cache_stampede). If multiple calls are made at roughly the same time before the first call has completed, only the first call is actually really made. Subsequent calls are deferred and are responded to as soon as the result of the first call is available. This is even true across processes, if you have multiple apps running the same function.

Cache stampedes are prevented by using the [redis-lock](https://github.com/errorception/redis-lock) module, which ensures that only one function can be executed at a time. Since the lock itself is held in redis, it is shared across processes. So, for the same arguments, the same function will only be executed in one process. Other processes will wait for the first one to finish its job and cache its result to redis. Once the lock has been released, other functions will then use the cached value from redis.

redis-lock is only used when there's no memo found in redis. When memos exist in redis, there's no locking.

## Installation

Use npm to install redis-memoizer:
```
npm install redis-memoizer
```

To run the tests, install the dev-dependencies by `cd`'ing into `node_modules/redis-memoizer` and running `npm install` once, and then `npm test`.

## Other notes

* If your function or the resulting promise throws an error, the error isn't cached to redis. In this scenario, this module acts as a pass-through.
* There has been a lot of effort to make the whole thing feel JavaScript-y. However, under the hood, there's JSON serialization/deserialization going on. Hence this module can only work with datatypes that can be serialized to JSON without losing fidelity. This applies to both the arguments that you pass to the function, and to the return value you get when the function's promise is resolved. Since we are limited to what JSON can do, prototype chains aren't preserved, functions can't be passed around, and complex types (such as Dates) are `.toJSON`ed or `.toString`ed. That said, this module does put in some effort to handle `null`s, `undefined`s and booleans correctly so that primitive types work seamlessly. Plain objects, arrays, strings and numbers work just fine at any level of nesting.

## Migrating from 0.x to 1.x

1.x is essentially a rewrite of the module, though it hasn't changed much in principle. The primary change is that 1.x drops support for the old callback-style node code, in favor of supporting async/await based on native node promises.

When migrating, you'll need to modify your code as follows:
* Since this module doesn't support the old callback style of flow control, you'll either need to modify your functions to be a promise-based API, or you'll need to wrap it in a suitable wrapper that makes it appear to have a promise-based API.
* 0.x used to take the redis port, host and options as arguments when initializing. Instead, 1.x takes a pre-configured redis client object created by calling `redis.createClient(...)`.
* The `memoize` function now takes an options object as its second argument. It previously took a number or function that determined the timeout. When migrating, you can set `options.ttl` to specify the timeout. `options.ttl` can either be a number or a function, so it mirrors the behaviour of the old `timeout` argument.
* `options.name` wasn't exposed before, but is now a reqired property. This module will `throw` without it. The 0.x version used the `function.toString()` argument to identify the function. This was problematic, and could cause very hard to debug issues due to cache collision. By taking the `.name` property explicitly, the problem is avoided.

The other thing you should be aware of when migrating is that the 0.x versions used to prevent cache-stampedes by doing stuff in memory. This restricted the cache-stampede prevention mechanism to the same process. The 1.x version uses redis-lock to prevent cache-stampedes, which works across processes. This shouldn't really affect anything externally, but it's worth knowing that there is the additional lock property being stored in redis.

## License

MIT