
var async = require('async'),
	crypto = require('crypto'),
	http = require('http'),
	https = require('https'),
	url = require('url'),
	redis = require('redis').createClient(),
	fs = require('fs'),
	kue = require('kue'),
	util = require('util'),
	extend = require('xtend'),
	jobs = kue.createQueue();

var path = __dirname+'/images', images = fs.readdirSync(path).map(function(name) {
	var data = fs.readFileSync(path+'/'+name)
	return {
		name: name,
		data: data,
		hash: crypto.createHash('sha1').update(data).digest('hex')
	}
});

var agents = {
	'http:': new http.Agent({ maxSockets: 256 }),
	'https:': new https.Agent({ maxSockets: 256, rejectUnauthorized: false })
}

var engines = {
	'http:': http,
	'https:': https
}


var runs = {
	1: function connectivity(url, job, callback) {
		var opts = {
			image: images[0], //default image
			timeout: 30000, //30s request timeout
			count: 1, //Send only 1 thumbnail request
			retries: 40, //Try 20 times to fetch thumbnails
			delay: 1000, //Wait at least 1s between each try
			inFlight: 1
		}

		requests(url, job, opts, undefined, callback);
	},

	2: function performance(u, job, callback) {
		var base = {
			image: images[4], //send the nastiest image
			timeout: 10000, //10s timeout
			count: 10, //Send 5 requests
			retries: 200, //Try 200 times to fetch thumbnails
			delay: 200, //Wait at least 0.2s between each try
		};

		var baseline;

		async.series([
			
			//Load the system for approximately 5 minutes
			function(next) {
				job.log('Calculating your baseline performance.');
				
				requests(u, job, base, undefined, function(err, results) {
					if (err) return next(err);
					baseline = stats(results);
					job.log('✓ Baseline discovered: '+JSON.stringify(baseline)+'!')
					redis.hset('url:'+url.format(u), 'baseline', JSON.stringify(baseline));
					next();
				});
			},

			function(next) {
				var successes = 0;
				job.log('info', 'Flying 3 images at a time your way. Good luck.');
				requests(u, job, extend(base, { inFlight: 3, count: 100 }), function(batch, i, next) { 
					//Ignore the first 3 chunks to give the queue time to pile up
					if (i < 3) return next(undefined, false);
					var s = stats(batch);
					if ((Math.abs(s.mean - baseline.mean) <= baseline.standardDeviation/2.5) && s.standardDeviation <= baseline.standardDeviation+300)
						++successes;
					
					if (successes > 5) {
						job.log('✓ Performance goal acheived '+JSON.stringify(s)+'!');
						return next(undefined, true);
					}
					
					next(undefined, false);
					
				}, function(err, results, stopped) {
					if (err) return next(err);
					if (!stopped) return next({ error: 'PERFORMANCE_UNACCEPTABLE', stats: stats(results) });
					next()
				});
			}

		], callback)	
	}
}


function requests(url, job, opts, batch, callback) {
	
	function queue(out, limit) {

		var res = [ ], remaining = n = Math.min(opts.inFlight || 1, limit);

		if (remaining <= 0) return callback(undefined, out);

		for (var i = 0; i < n; ++i) {
			request(url, job, { image: opts.image, timeout: opts.timeout }, function(err, result) {
				if (err) return callback(err);
				async.map(Object.getOwnPropertyNames(result.data), function(key, next) {
					check(key, job, result.data[key], opts.retries, opts.delay, opts.timeLimit, next);
				}, function(err, results) {
					if (err) return callback(err);
					var s = stats(results);
					res.push({ name: opts.image.name, waited: s.max });
					if (--remaining <= 0) {
						if (batch)
							batch(res, Math.floor((opts.count - limit)/n), function(err, stop) {
								if (err) return callback(err);
								if (stop)
									callback(undefined, out.concat(res), true)
								else
									queue(out.concat(res), limit - n);
							});
						else
							queue(out.concat(res), limit - n);
						
					}
				});
			})
		}
	}

	queue([], opts.count);

}


function stats(results) {
	results = results.filter(function(entry) {
		return entry.name !== 'original';
	});

	var u, s, min, max, nums;

	nums = results.map(function(r) { return r.waited });
	u = nums.reduce(function(s,r) { return s+r }, 0)/nums.length;
	s = Math.sqrt(nums.reduce(function(s, r) { return s+Math.pow(r-u,2) })*(1/nums.length));
	min = Math.min.apply(Math, nums);
	max = Math.max.apply(Math, nums);

	return {
		mean: u,
		standardDeviation: s,
		min: min,
		max: max
	}
}

function check(name, job, _u, total, minDelay, timeLimit, callback) {

	var u = url.parse(_u), engine = engines[u.protocol], timeout = false;
	var start = Date.now(), sequence = Math.random().toString(36).substr(2), timer;
	var current = null, aborted = false, called = false;

	if (timeLimit)
		timer = setTimeout(function() {
			timeout = true;
			job.log('TIME LIMIT HIT!');
			called = true;
			callback({ name: name, error: 'TIMELIMIT_REACHED', value: timeLimit });
		}, timeLimit);

	function retry(count, lastStart) {
		var idx = total - count + 1, prefix = '[' +sequence+ ']['+idx+'/'+total+'] ('+url.format(u)+'):';
		
		function run() {
			var localStart = Date.now();
			if (timeout) return;
			if (count === 0) { 
				called = true; 
				return callback({ name: name, error: 'RETRIES_EXCEEDED', waited: Date.now() - start, count: total - count, url: url.format(u) });
			}
			//log.write('info', prefix + ' GET');
			current = engine.request({ 
				method: 'GET',
				hostname: u.hostname,
				port: u.port,
				path: u.path,
				agent: agents[u.protocol]
			}, function(res) {
				var end = Date.now(), waited = end - start,
					success = res.statusCode >= 200 && res.statusCode < 300;

				if (success)
					job.log((success ? '✓' : '✘')+prefix+' HTTP '+res.statusCode+' '+' in '+waited+' ms.');
				
				if (success) {
					if (timer)
						clearTimeout(timer);
					called = true;
					callback(undefined, { name: name, count: total - count, waited: waited })
				} else {
					if (!aborted && !timeout)
						retry(count-1, localStart)
				};
			}).on('error', function(err) {
				job.log('✘'+prefix+' error: '+err);
				if (!aborted && !timeout)
					retry(count - 1, localStart);
			});

			current.setTimeout(5000, function() {
				if (called) return;
				job.log('✘'+prefix+' timeout!');
				current.abort();
			});

			current.end();
		}

		var remaining = (lastStart - Date.now()) + minDelay;
		if (remaining > 0) setTimeout(run, remaining);
		else run();
	}

	retry(total, 0);

	return {
		cancel: function() {
			aborted = true;
			if (current)
				current.abort();
			if (!called)
				callback({ error: 'ABORTED' })
		}
	}
}

function request(url, job, opts, result) {
	var id = Math.random().toString(36).substr(2),
		_r = {
			method: 'POST',
			hostname: url.hostname,
			port: url.port,
			path: url.path,
			headers: {
				'X-Request-Id': id,
				'X-Content-Hash': opts.image.hash
			},
			agent: agents[url.protocol]
		};

	job.log('['+id+']: '+_r.method+' '+url.path+' with image '+opts.image.name+' (length: '+opts.image.data.length+' bytes, sha1: '+opts.image.hash+')');

	var request = http.request(_r, function(response) {
			var data = '', success = response.statusCode >= 200 && response.statusCode < 300;
			
			response.setTimeout(opts.timeout, function() {
				response.close();
				log.write('info', 'TIMEOUT');
				result({ error: 'RESPONSE_TIMEOUT', data: opts.timeout, request: _r });
			})

			//log.write('info', '['+id+']: Receiving response...');

			response.on('readable', function() {
				var chunk;
				while (chunk = this.read())
					data += chunk.toString('utf8');
			}).on('end', function() {
				job.log('['+id+']: Response received.');
				if (success) {
					var obj;
					try {
						obj = JSON.parse(data);
					}
					catch (E) {
						return result({ error: 'INVALID_JSON', data: data, exception: E, request: _r });
					}
					result(undefined, { request: _r, data: obj });
				}
				else {
					result({ error: 'INVALID_HTTP_RESPONSE', code: response.statusCode, data: data, request: _r });
				}
			}).on('error', function(err) {
				result({ error: 'RESPONSE_ERROR', data: err, request: _r });
			});
		});

	request.on('error', function(err) {
		if (err && err.code === 'ECONNRESET') return;
		result({ error: 'REQUEST_ERROR', data: err, request: _r });
	});

	request.setTimeout(opts.timeout, function() {
		request.abort();
		result({ error: 'REQUEST_TIMEOUT', data: opts.timeout, request: _r });
	});

	var boundaryKey = Math.random().toString(36).substr(2);
	request.setHeader('Content-Type', 'multipart/form-data; boundary="'+boundaryKey+'"');
	
	var header = '--' + boundaryKey + '\r\n' +
		// use your file's mime type here, if known
		'Content-Type: application/octet-stream\r\n' +
		// "name" is the name of the form field
		// "filename" is the name of the original file
		'Content-Disposition: form-data; name="image"; filename="'+opts.image.name+'"\r\n' + 
		'Content-Transfer-Encoding: binary\r\n' +
		'Content-Length: '+opts.image.data.length + '\r\n\r\n',
		trailer = '\r\n--' + boundaryKey + '--\r\n';


	request.setHeader('Content-Length', header.length+opts.image.data.length+trailer.length);

	request.write(header);
	request.write(opts.image.data);
	request.write(trailer);
	request.end();

	return {
		cancel: function() {
			request.abort()
		}
	}
}

jobs.process('profile', 3, function(job, done) {
	var u = job.data.url, user = job.data.user, part = job.data.part;

	console.log('Processing job #'+job.id+'...');

	//Check for valid protocols
	if (!engines[u.protocol]) return;
	if (!runs[part]) return done({ error: 'INVALID_PART', part: part });
	
	redis.hset('user:'+user, 'url-'+url.format(u), Date.now());
	job.log('Starting run for '+part+'.');
	runs[part](u, job, function(err) {
		job.log('Completed run for '+part+'.');
		if (err) job.log('error: '+util.inspect(err));
		console.log('Done job #'+job.id+'.');
		done(err ? util.inspect(err) : undefined);
	});
});

process.once('SIGTERM', function ( sig ) {
	queue.shutdown(function(err) {
		console.log('Kue is shut down.', err||'');
		process.exit(0);
	}, 5000);
});
