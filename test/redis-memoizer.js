const client = require('redis').createClient();
const memoize = require('../')(client);
const crypto = require('crypto');
const should = require('should');
const { promisify } = require('util');
const delay = require('delay2');

const redisDel = promisify(client.del).bind(client);

const hash = string => crypto.createHmac('sha1', 'memo').update(string).digest('hex');

const clearCache = async (fnName, args = []) => {
  await redisDel('memos:' + fnName + ':' + hash(JSON.stringify(args)));
}

describe('redis-memoizer', () => {
  after(process.exit);

  it('should memoize a value correctly', async () => {
    const functionDelayTime = 10;
    let callCount = 0;
    const functionToMemoize = async (val1, val2) => {
      callCount++;
      await delay(functionDelayTime);
      return { val1, val2 };
    };
    const memoized = memoize(functionToMemoize, { name: 'testFn' });

    let start = Date.now();
    let { val1, val2 } = await memoized(1, 2);
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start >= functionDelayTime).should.be.true;		// First call should go to the function itself
    callCount.should.equal(1);

    start = Date.now();
    ({ val1, val2 } = await memoized(1, 2));
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start < functionDelayTime).should.be.true;		// Second call should be faster
    callCount.should.equal(1);

    await clearCache('testFn', [1, 2]);
  });

  it('should memoize separate function separately', async () => {
    const function1 = async arg => { await delay(10); return 1; };
    const function2 = async arg => { await delay(10); return 2; };

    const memoizedFn1 = memoize(function1, { name: 'function1' });
    const memoizedFn2 = memoize(function2, { name: 'function2' });

    (await memoizedFn1('x')).should.equal(1);
    (await memoizedFn2('y')).should.equal(2);
    (await memoizedFn1('x')).should.equal(1);

    await clearCache('function1', ['x']);
    await clearCache('function2', ['y']);
  });

  it('should prevent a cache stampede', async () => {
    try {
    const functionDelayTime = 10;
    const iterationCount = 10;
    let callCount = 0;

    const fn = async () => {
      callCount++;
      await delay(functionDelayTime);
    };
    const memoized = memoize(fn, { name: 'testFn' });

    let start = Date.now();
    await Promise.all([ ...Array(iterationCount).keys() ].map(() => memoized()));
    (Date.now() - start < functionDelayTime * iterationCount).should.be.true;
    callCount.should.equal(1);

    await clearCache('testFn');
  } catch(e) { console.log(e); }
  });

  it(`should respect 'this'`, async () => {
    function Obj() { this.x = 1; }
    Obj.prototype.y = async function() {
      await delay(10);
      return this.x;
    };

    const obj = new Obj();
    const memoizedY = memoize(obj.y, {name: 'Obj.y'}).bind(obj);

    (await memoizedY()).should.equal(1);

    await clearCache('Obj.y');
  });

  it('should respect the ttl', async () => {
    const ttl = 100;
    const functionDelayTime = 10;

    const fn = async () => await delay(functionDelayTime);
    const memoized = memoize(fn, { name: 'testFn', ttl });

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit.
    start = Date.now();
    await memoized();
    (Date.now() - start < functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired
    await delay(ttl + 10);
    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    await clearCache('testFn');
  });

  it('should allow ttl to be a function', async () => {
    const functionDelayTime = 10;
    const ttl = 100;
    const fn = async () => await delay(functionDelayTime);
    const memoized = memoize(fn, { ttl: () => ttl, name: 'testFn' });

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit
    start = Date.now();
    await memoized();
    (Date.now() - start <= functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired;
    await delay(ttl + 10);

    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    await clearCache('testFn');
  });

  it('should work if complex types are accepted and returned', async () => {
    const functionDelayTime = 10;
    const fn = async arg1 => {
      await delay(functionDelayTime);
      return { arg1, some: ['other', 'data'] }
    };

    const memoized = memoize(fn, { name: 'testFn' });

    let start = Date.now();
    let { arg1, some } = await memoized({ input: 'data' });
    (Date.now() - start >= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);
    
    start = Date.now();
    ({ arg1, some } = await memoized({ input: 'data' }));
    (Date.now() - start <= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);

    await clearCache(fn, [{input: "data"}]);
  });

  it('should memoize even if result is falsy', async () => {
    await Promise.all([undefined, null, false, ''].map(async falsyValue => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return falsyValue;
      }

      const memoized = memoize(fn, { name: 'testFn' });

      (await memoized() === falsyValue).should.be.true;
      (await memoized() === falsyValue).should.be.true;  // Repeated, presumably cache-hit
      callCount.should.equal(1);  // Verify cache hit

      await clearCache('testFn');
    }));
  });

  it(`shouldn't memoize errors`, async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Test error');
    }

    const memoized = memoize(fn, { name: 'testFn' });

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(1);
    }

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(2);
    }
  });
});