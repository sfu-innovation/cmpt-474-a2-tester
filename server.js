
var cas = require('./cas'),
	fs = require('fs'),
	http = require('http'),
	https = require('https'),
	url = require('url'),
	express = require('express'),
	redis = require('redis').createClient(),
	secret = fs.existsSync('.secret') ? fs.readFileSync('.secret', 'utf-8') : Math.random().toString(36).substr(2),
	async = require('async'),
	app = express(),
	cookie = 'sid',
	cookieParser = express.cookieParser(secret),
	server = http.createServer(app),
	RedisStore = require('connect-redis')(express),
	io = require('socket.io').listen(server, { log: false }),
	sessionStore = new RedisStore({ client: redis }),
	kue = require('kue'),
	jobs = kue.createQueue(),
	Job = kue.Job,
	extend = require('xtend'),
	util = require('util');

fs.writeFileSync('.secret', secret);

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



//god bless JS spaghettis


app.set('view engine', 'jade');

app.use(express.static(__dirname+'/public'))

app.use(cookieParser);
app.use(express.session({
	store: sessionStore,
	key: cookie
}));

function authenticated(users) {
	return function (req, res, next) {
		if (req.session.user) return next();
		return res.redirect('/login');
	}
}

function authorized(users) {
	var check = { };
	for (var i = 0; i < users.length; ++i)
		check[users[i]] = true;
	return function(req, res, next) {
		if (check[req.session.user]) return next();
		else return next({ code: 403, error: 'NOT_AUTHORIZED' })
	}
}


function load(id, cb) {
	Job.get(id, function(err, job) {
		if (err) return cb(err);
		cb(undefined, {
			id: job.id,
			data: job.data,
			state: job._state,
			progress: job._progress,
			createdAt: job.created_at
		});	
	});
}

app.get('/login', cas(), function(req, res) {
	if (req.casId) req.session.user = req.casId;
	return res.redirect('/');
})


app.use('/kue', authenticated())
app.use('/kue', authorized(['ted', 'mis2'])); //sorry boys
app.use('/kue', kue.app);

app.get('/', authenticated(), function(req, res, next) {
	
	var user = req.session.user;

	async.parallel([
		function(next) {
			redis.hgetall('user:'+user+':results', next)
		},
		function(next) {
			redis.smembers('user:'+user+':jobs', function(err, jobs) {
				if (err) return next(err);
				return async.map(jobs, load, next);
			})
		}
	], function(err, results) {
		res.render('index', {
			user: user,
			parts: results[0] || { },
			jobs: results[1] || [ ]
		});
	})
	
});

app.param('job', function(req, res, next, id) {
	Job.get(id, function(err, job) {
		if (err) return next(err);
		req.job = job;
		next();
	});
})

app.post('/job', authenticated(), express.json(), function(req, res, next) {
	//Someone is having fun messing with the code
	var data = req.body;

	res.set('Content-Type', 'application/json');

	if (!data || !data.parts || !data.url) return next({ error: 'INVALID_DATA', data: data, statusCode: 400 });

	var u = url.parse(data.url), parts = data.parts;

	//For people who forget the http:// in front of their URL
	if (!u.protocol) { u = url.parse('http://'+data.url) }
	//Check for valid parts
	if (!Array.isArray(parts)) return next({ error: 'INVALID_DATA', data: data, statusCode: 400 });

	async.forEach(parts, function(part, next) {
		jobs.create('profile', {
			title: 'Profile #'+part+' against '+url.format(u),
			user: req.session.user,
			url: u,
			part: part
		}).attempts(1).save(next);
	}, function(err) {
		if (err) next(err);
		res.send(202, { status: 'CREATED' });
	});
})

app.get('/job/:job/log', authenticated(), function(req, res) {
	res.set('Content-Type', 'application/json');
	if (req.job.data.user !== req.session.user) return next({ error: 'NOT_AUTHORIZED' });
	Job.log(req.job.id, function(err, logs) {
		if (err) return next(err);
		res.send(200, { job: req.job.id, logs: logs });
	});
});

app.post('/job/:job/cancel', authenticated(), function(req, res, next) {
	res.set('Content-Type', 'application/json');
	if (req.job.data.user !== req.session.user) return next({ error: 'NOT_AUTHORIZED' });
	req.job.cancel();
	res.send(202, { status: 'CANCELED' });
})


function sockets(user) {
	var entries = io.sockets.clients().filter(function(socket) {
		return socket.handshake.user === user;
	});
	return {
		emit: function(evt) {
			var params = Array.prototype.slice.call(arguments);
			entries.forEach(function(entry) {
				entry.emit.apply(entry, params);
			});
			return this;
		},
		on: function(evt, f) {
			entries.forEach(function(entry) {
				entry.on(evt, f);
			});
			return this;
		}
	}
}


jobs.on('job state', function(id) {
	load(id, function(err, job) {
		if (err) return;
		switch(job.state) {
		case 'inactive':
			redis.sadd('user:'+job.data.user+':jobs', job.id);
			break;
		case 'complete':
			redis.hset('user:'+job.data.user+':results', job.data.part, 'true');
			break;
		}
		sockets(job.data.user).emit('job state', job);	
	});
}).on('job progress', function(id, progress) {
	load(id, function(err, job) {
		if (err) return;
		sockets(job.data.user).emit('job progress', job, progress);	
	});
}).on('job log', function(id, log) {
	console.log('job log '+arguments)
	load(id, function(err, job) {
		if (err) return;
		sockets(job.data.user).emit('job log', job, log);	
	});
})


server.listen(80);
