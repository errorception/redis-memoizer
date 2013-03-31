var redis = require('redis'),
	crypto = require('crypto');

module.exports = function() {
	var client = redis.createClient.apply(null, arguments);

	function hash(string) {
		return crypto.createHmac('sha1', 'memo').update(string).digest('hex');
	}

	function getKeyFromRedis(ns, key, done) {
		client.get('memos:' + ns + ':' + key, function(err, value) {
			done(err, JSON.parse(value));
		});
	}

	function writeKeyToRedis(ns, key, value, ttl, done) {
		client.setex('memos:' + ns + ':' + key, ttl, JSON.stringify(value), done);
	}

	return function memoize(fn, ttl) {
		var functionKey = hash(fn.toString()),
			inFlight = {},
			ttlfn;

		if(typeof ttl == 'function') {
			ttlfn = ttl;
		} else {
			ttlfn = function() { return ttl || 120; }
		}

		return function memoizedFunction() {
			var self = this,	// if 'this' is used in the function
				args = Array.prototype.slice.call(arguments),
				done = args.pop(),
				argsStringified = args.map(function(arg) { return JSON.stringify(arg); }).join(",");

			argsStringified = hash(argsStringified);

			getKeyFromRedis(functionKey, argsStringified, function(err, value) {
				if(value) {
					done.apply(self, value);
				} else if(inFlight[argsStringified]) {
					inFlight[argsStringified].push(done);
				} else {
					inFlight[argsStringified] = [done];

					fn.apply(self, args.concat(function() {
						var resultArgs = Array.prototype.slice.call(arguments);

						writeKeyToRedis(functionKey, argsStringified, resultArgs, ttlfn.apply(null, resultArgs));

						if(inFlight[argsStringified]) {
							inFlight[argsStringified].forEach(function(cb) {
								cb.apply(self, resultArgs);
							});
							delete inFlight[argsStringified];
						}
					}));
				}
			});
		}
	}
}