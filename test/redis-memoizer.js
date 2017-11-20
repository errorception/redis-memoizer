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
    const functionDelayTime = 100;
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
    const function1 = async arg => { await delay(100); return 1; };
    const function2 = async arg => { await delay(100); return 2; };

    const memoizedFn1 = memoize(function1, { name: 'function1' });
    const memoizedFn2 = memoize(function2, { name: 'function2' });

    (await memoizedFn1('x')).should.equal(1);
    (await memoizedFn2('y')).should.equal(2);
    (await memoizedFn1('x')).should.equal(1);

    await clearCache('function1', ['x']);
    await clearCache('function2', ['y']);
  });

  it('should prevent a cache stampede', async () => {
    const functionDelayTime = 100;
    const iterationCount = 10;
    let callCount = 0;
    
    const fn = async () => {
      callCount++;
      await delay(functionDelayTime);
    }
    const memoized = memoize(fn, { name: 'testFn' });

    let start = Date.now();
    await Promise.all([ ...Array(iterationCount).keys() ].map(() => memoized()));
    (Date.now() - start < functionDelayTime * iterationCount).should.be.true;
    callCount.should.equal(1);

    await clearCache('testFn');
  });

  it(`should respect 'this'`, async () => {
    function Obj() { this.x = 1; }
    Obj.prototype.y = async function() {
      await delay(100);
      return this.x;
    };

    const obj = new Obj();
    const memoizedY = memoize(obj.y, {name: 'Obj.y'}).bind(obj);

    (await memoizedY()).should.equal(1);

    await clearCache('Obj.y');
  });

  it('should respect the ttl', async () => {
    const ttl = 500;
    const functionDelayTime = 100;

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
    const functionDelayTime = 100;
    const fn = async () => await delay(functionDelayTime);
    const memoized = memoize(fn, { ttl: () => 200, name: 'testFn' });

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit
    start = Date.now();
    await memoized();
    (Date.now() - start <= functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired;
    await delay(300);

    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    await clearCache('testFn');
  });

  it('should work if complex types are accepted and returned', async () => {
    const functionDelayTime = 100;
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
});