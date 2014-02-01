
var cas = require('./cas'),
	fs = require('fs'),
	crypto = require('crypto'),
	http = require('http'),
	https = require('https'),
	url = require('url'),
	express = require('express'),
	redis = require('redis').createClient(),
	secret = Math.random().toString(36),
	async = require('async'),
	app = express(),
	cookie = 'sid',
	cookieParser = express.cookieParser(secret),
	server = http.createServer(app),
	RedisStore = require('connect-redis')(express),
	io = require('socket.io').listen(server, { log: false }),
	sessionStore = new RedisStore({ client: redis }),
	extend = require('xtend'),
	util = require('util');


io.set('authorization', function (data, callback) {
	if(!data.headers.cookie)
		return callback({ error: 'NO_COOKIE' }, false);
	
	// We use the Express cookieParser created before to parse the cookie
	// Express cookieParser(req, res, next) is used initialy to parse data in "req.headers.cookie".
	// Here our cookies are stored in "data.headers.cookie", so we just pass "data" to the first argument of function
	cookieParser(data, { }, function(parseErr) {
		if(parseErr) { return callback({ error: 'INVALID_COOKIE' }, false); }

		// Get the SID cookie
		var sidCookie = (data.secureCookies && data.secureCookies[cookie]) ||
			(data.signedCookies && data.signedCookies[cookie]) ||
			(data.cookies && data.cookies[cookie]);

		// Then we just need to load the session from the Express Session Store
		sessionStore.load(sidCookie, function(err, session) {
			// And last, we check if the used has a valid session and if he is logged in
			if (err || !session || !session.user) {
				callback({ error: 'NOT_AUTHENTICATED' }, false);
			} else {
				// If you want, you can attach the session to the handshake data, so you can use it again later
				data.user = session.user;
				callback(null, true);
			}
		});
	});
});


var path = __dirname+'/images', images = fs.readdirSync(path).map(function(name) {
	var data = fs.readFileSync(path+'/'+name)
	return {
		name: name,
		data: data,
		hash: crypto.createHash('sha1').update(data).digest('hex')
	}
});

var agents = {
	'http:': new http.Agent({ maxSockets: 1000 }),
	'https:': new https.Agent({ maxSockets: 1000, rejectUnauthorized: false })
}

var engines = {
	'http:': http,
	'https:': https
}


function check(name, log, _u, total, minDelay, timeLimit, callback) {

	var u = url.parse(_u), engine = engines[u.protocol], timeout = false;
	var start = Date.now(), sequence = Math.random().toString(36).substr(2), timer;
	var current = null, aborted = false, called = false;

	if (timeLimit)
		timer = setTimeout(function() {
			timeout = true;
			log.write('info', 'TIME LIMIT HIT!');
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
				return callback({ name: name, error: 'RETRIES_EXCEEDED', waited: Date.now() - start, count: total - count });
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
					log.write('info', (success ? '✓' : '✘')+prefix+' HTTP '+res.statusCode+' '+' in '+waited+' ms.');
				
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
				log.write('info', '✘'+prefix+' error: '+err);
				if (!aborted && !timeout)
					retry(count - 1, localStart);
			});

			current.setTimeout(5000, function() {
				if (called) return;
				log.write('info', '✘'+prefix+' timeout!');
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

function request(url, log, opts, result) {
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

	log.write('info', '['+id+']: '+_r.method+' '+url.path+' with image '+opts.image.name+' (length: '+opts.image.data.length+' bytes, sha1: '+opts.image.hash+')');

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
				log.write('info', '['+id+']: Response received.');
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
	//log.write('info', '['+id+']: Request sent off.');

	return {
		cancel: function() {
			request.abort()
		}
	}
}

//god bless JS spaghettis


app.set('view engine', 'jade');

app.use(express.static(__dirname+'/public'))

app.use(cookieParser);
app.use(express.session({
	store: sessionStore,
	key: cookie
}));


app.get('/', function(req, res, next) {
	if (req.session.user) return next('route');
	next();
}, cas(), function(req, res) {
	req.session.user = req.casId;
	res.redirect('/');
});

app.get('/', function(req, res, next) {
	redis.hgetall('user:'+req.session.user, function(err, data) {
		if (err) return next(err);
		var urls = { }, parts = { 1: 'incomplete', 2: 'incomplete' };
		for (var k in data) {
			var item;
			if (item = k.match(/^url-(.*)$/))
				urls[item[1]] = data[k];
			else if (item = k.match(/^part-(.*)$/))
				parts[item[1]] = data[k];
		}

		res.render('index', {
			user: req.session.user,
			urls: urls,
			parts: parts
		});
	})
	
});

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

var runs = {
	1: function connectivity(url, log, callback) {
		var opts = {
			image: images[0], //default image
			timeout: 30000, //30s request timeout
			count: 1, //Send only 1 thumbnail request
			retries: 40, //Try 20 times to fetch thumbnails
			delay: 1000, //Wait at least 1s between each try
			inFlight: 1
		}

		requests(url, log, opts, undefined, callback);
	},

	2: function performance(u, log, callback) {
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
				log.write('info', 'Calculating your baseline performance.');
				
				requests(u, log, base, undefined, function(err, results) {
					if (err) return next(err);
					baseline = stats(results);
					log.write('info', '✓ Baseline discovered: '+JSON.stringify(baseline)+'!')
					redis.hset('url:'+url.format(u), 'baseline', JSON.stringify(baseline));
					next();
				});
			},

			function(next) {
				var successes = 0;
				log.write('info', 'Flying 3 images at a time your way. Good luck.');
				requests(u, log, extend(base, { inFlight: 3, count: 100 }), function(batch, i, next) { 
					//Ignore the first 3 chunks to give the queue time to pile up
					if (i < 3) return next(undefined, false);
					var s = stats(batch);
					if ((Math.abs(s.mean - baseline.mean) <= baseline.standardDeviation/3) && s.standardDeviation <= baseline.standardDeviation)
						++successes;
					
					if (successes > 5) {
						log.write('info', '✓ Performance goal acheived '+JSON.stringify(s)+'!');
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

io.sockets.on('connection', function (socket) {


	socket.on('profile', function (data) {

		//Someone is having fun messing with the code
		if (!data || !data.parts || !data.url) return;

		var u = url.parse(data.url);
		redis.hset('user:'+socket.handshake.user, 'url-'+data.url, Date.now());
		async.mapSeries(data.parts, function(part, next) {
			socket.emit('state', { part: part, value: 'pending' });
			if (!runs[part]) return next({ error: 'INVALID_PART', part: part });
			var log = {
				write: function(level, msg) {
					socket.emit('log', { id: Math.random().toString(36).substr(2), part: part, level: level, data: msg });
				}
			}
			log.write('info', 'Starting run for '+part+'.');
			runs[part](u, log, function(err) {
				log.write('info', 'Completed run for '+part+'.')
				socket.emit('state', { part: part, value: err ? 'error' : 'complete' });
				if (err) log.write('error', util.inspect(err));
				else redis.hset('user:'+socket.handshake.user, 'part-'+part, 'success');
				next(err);
			});
		}, function(err) {

		})
	});
});

//console.log(images);

//notify('info', 'Running basic work tests...')

function requests(url, log, opts, batch, callback) {
	
	function queue(out, limit) {

		var res = [ ], remaining = n = Math.min(opts.inFlight || 1, limit);

		console.log('putting '+n+'in flight out of '+limit+'.')

		if (remaining <= 0) return callback(undefined, out);

		for (var i = 0; i < n; ++i) {
			request(url, log, { image: opts.image, timeout: opts.timeout }, function(err, result) {
				if (err) return callback(err);
				async.map(Object.getOwnPropertyNames(result.data), function(key, next) {
					check(key, log, result.data[key], opts.retries, opts.delay, opts.timeLimit, next);
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


server.listen(80);