
var 
	https = require('https'),
	querystring = require('querystring'),
	url = require('url');

function handleTicket(req, res, next) {
	var localUrl = url.format({
			protocol: req.protocol,
			host: req.headers['host'],
			pathname: req._parsedUrl.pathname
		});
	if (req.query.ticket) {
		verifyTicket(localUrl, req.query.ticket, function(err, user) {
			if (err) return next(err);
			req.casId = user;
			next();
		});
	}
	else {
		res.redirect('https://cas.sfu.ca/cgi-bin/WebObjects/cas.woa/wa/login?'+querystring.stringify({
			service: localUrl
		}));

	}
}

function verifyTicket(url, ticket, callback) {	
	
	if (typeof ticket !== 'string') return callback('invalid ticket');
	if (typeof url !== 'string') return callback('invalid url');
	
	https.request({
		method: 'GET',
		host: 'cas.sfu.ca',
		path: '/cgi-bin/WebObjects/cas.woa/wa/serviceValidate?'+querystring.stringify({
			service: url,
			ticket: ticket
		})
	}, function(response) {
		var data = '';
		response.on('readable', function() {
			data += this.read().toString('utf8');
		}).on('end', function() {
			var parts;
			if (parts = data.match(/<cas:user>([a-zA-Z0-9_-]+)<\/cas:user>/)) {
				callback(undefined, parts[1]);
			}
			else {
				callback('invalid ticket');
			}
		})
	}).on('error', function(error) {
		callback(error);
	}).end();
}

module.exports = function() {
	return handleTicket;
}; 