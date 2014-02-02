require.config({
	shim: {
		'highcharts': {
			exports: 'Highcharts',
			deps: [ 'jquery' ]
		},
		'socket.io': {
			exports: 'io'
		}
	
	},
	paths: {
		'jquery': 'http://code.jquery.com/jquery-2.0.3.min',
		'socket.io': '/socket.io/socket.io'
	}
});
require(['jquery', 'highcharts', 'socket.io', 'spin'], function($, Chart, io, Spinner) {
	var socket = io.connect();

	socket.on('error', function(err) {
		alert('socket.io error: '+err);
	});

	function jobElement(job) {
		var element = $('.jobs .job[data-id='+job.id+']');
		if (element.length === 0)
			element = $('<li class="job" data-id='+job.id+'><p class="title"/><p class="latest-message"/></li>').appendTo($('.jobs'));
		return element;
	}

	socket.on('job state', function(job) {
		console.log('new state: ', job);
		var element = jobElement(job);
		element.attr('data-state', job.state);
		element.attr('data-progress', job.progress);
		element.attr('data-created-at', job.createdAt);
		element.find('.title').text(job.data.title);
	}).on('job progress', function(job, progress) {
		console.log('job '+job.id+': '+progress)
		jobElement(job).attr('data-progress', progress);
	}).on('job log', function(job, message) {
		console.log('job '+job.id+': '+message);
		jobElement(job).find('.latest-message').text(message);
		$('.log-viewer[data-job='+job.id+']').each(function() {
			var msg = $('<div class="entry"></div>');
			msg.text(message);
			$(this).append(msg);
		});
	});

	$('.jobs').on('click', '.job .show-log', function() {
		var id = $(this).closest('.job').data('id');
		job.log(id, function(err, data) {
			if (err) alert('Unable to get logs!');
			console.log(data);
			var viewer = $('.log-viewer');
			viewer.attr('data-job', id).empty();
			data.logs.forEach(function(message) {
				var msg = $('<div class="entry"></div>');
				msg.text(message);
				viewer.append(msg);
			})
		})
		return false;
	}).on('click', '.job .cancel', function() {
		var id = $(this).closest('.job').data('id');
		job.cancel(id, function(err) {
			if (err) alert('Unable to cancel job!');
		})
		return false;
	});

	function send(method, url, data, callback) {
		$.ajax({
			url: url,
			data: JSON.stringify(data),
			dataType: 'json',
			contentType: 'application/json; charset=utf-8',
			type: method,
			success: function(data) {
				callback(undefined, data);
			},
			error: function(a,b,c) {
				callback(c || b || a || 'error');
			}
		});
	}


	var job = {
		create: function(url, parts, callback) {
			send('POST', '/job',  { url: url, parts: parts }, callback);
		},
		cancel: function(id, callback) {
			send('POST', '/job/'+id+'/cancel', undefined, callback);
		},
		log: function(id, callback) {
			send('GET', '/job/'+id+'/log', undefined, callback);
		}
	}


	$('form input[type=button]').on('click', function() {
		job.create($(this).closest("form").find('input[type=text]').val(), [ $(this).data('test') ], function(err) {
			if (err) alert('Unable to make job!');
			console.log(arguments)
		});
		return false;
	});

	$('form').on('submit', function() {
		var all = $(this).find('input[type=button]').map(function() { return $(this).data('test'); }).get();
		job.create($(this).find('input[type=text]').val(), all, function(err) {
			if (err) alert('Unable to make jobs!');
			console.log(arguments)
		});
		return false;
	})
})