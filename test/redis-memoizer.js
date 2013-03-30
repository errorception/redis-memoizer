var memoize = require('../')(),
	crypto = require('crypto'),
	redis = require('redis').createClient(),
	should = require('should');

describe('redis-memoizer', function() {
	function hash(string) {
		return crypto.createHmac('sha1', 'memo').update(string).digest('hex');
	}

	function clearCache(fn, args, done) {
		var stringified = args.map(function(arg) { return JSON.stringify(arg); }).join(",");
		redis.del('memos:' + hash(fn.toString()) + ':' + hash(stringified), done);
	}

	it('should memoize a value correctly', function(done) {
		var functionToMemoize = function (val1, val2, done) {
				setTimeout(function() { done(val1, val2); }, 500);
			},
			memoized = memoize(functionToMemoize);

		var start1 = new Date();
		memoized(1, 2, function(val1, val2) {
			val1.should.equal(1);
			val2.should.equal(2);
			(new Date - start1 >= 500).should.be.true;		// First call should go to the function itself

			var start2 = new Date();
			memoized(1, 2, function(val1, val2) {
				val1.should.equal(1);
				val2.should.equal(2);
				(new Date - start2 < 500).should.be.true;		// Second call should be faster

				clearCache(functionToMemoize, [1, 2], done);
			});
		});
	});

	it("should memoize separate function separately", function(done) {
		var function1 = function(arg, done) { setTimeout(function() { done(1); }, 200); },
			function2 = function(arg, done) { setTimeout(function() { done(2); }, 200); };

		var memoizedFn1 = memoize(function1),
			memoizedFn2 = memoize(function2);

		memoizedFn1("x", function(val) {
			val.should.equal(1);

			memoizedFn2("y", function(val) {
				val.should.equal(2);

				memoizedFn1("x", function(val) {
					val.should.equal(1);

					clearCache(function1, ["x"]);
					clearCache(function2, ["y"], done);
				});
			});
		});
	});

	it("should prevent a cache stampede", function(done) {
		var fn = function(done) { setTimeout(done, 500); },
			memoized = memoize(fn);

		var start = new Date;

		memoized(function() {
			// First one. Should take 500ms
			(new Date - start >= 500).should.be.true;

			start = new Date;	// Set current time for next callback;
		});

		memoized(function() {
			(new Date - start <= 10).should.be.true;
			clearCache(fn, [], done);
		});
	});

	it('should respect \'this\'', function(done) {
		function Obj() { this.x = 1; }
		Obj.prototype.y = memoize(function(done) {
			var self = this;

			setTimeout(function() {
				done(self.x);
			}, 300);
		});

		var obj = new Obj;

		obj.y(function(x) {
			x.should.equal(1);
			clearCache(obj.y, [], done);
		});
	});

	it('should respect the ttl', function(done) {
		var fn = function(done) { setTimeout(done, 200); },
			memoized = memoize(fn, 1);

		var start = new Date;
		memoized(function() {
			(new Date - start >= 200).should.be.true;

			// Call immediately again. Should be a cache hit
			start = new Date;
			memoized(function() {
				(new Date - start <= 100).should.be.true;

				// Wait some time, ttl should have expired
				setTimeout(function() {
					start = new Date;
					memoized(function() {
						(new Date - start >= 200).should.be.true;
						clearCache(fn, [], done);
					});
				}, 2000);
			});
		});
	});
});