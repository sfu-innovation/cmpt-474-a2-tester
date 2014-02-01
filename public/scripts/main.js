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
require(['jquery', 'highcharts', 'socket.io'], function($, Chart, io) {
	var socket = io.connect();

	socket.on('error', function(err) {
		alert('socket.io error: '+err);
	});

	socket.on('log', function(log) {
		console.log(log);
		if ($('.logs .log[data-id='+log.id+']').length > 0) return;
		var elem = $('<div class="log" data-id="'+log.id+'"></div>');
		elem.text(log.data);
		$('[data-part="'+log.part+'"] .logs').append(elem);
	}).on('state', function(state) {
		$('[data-part='+state.part+']').attr('data-state', state.value);
	})

	function profile(url, parts) {
		parts.forEach(function(part) {
			$('[data-part='+part+'] .logs').empty();
		});
		socket.emit('profile', { url: url, parts: parts })
	}

	$('form input[type=button]').on('click', function() {
		profile($(this.form).find('input[type=text]').val(), [ $(this).data('test') ]);
		return false;
	});

	$('form').on('submit', function() {
		var all = $(this).find('input[type=button]').map(function() { return $(this).data('test'); }).get();
		profile($(this).find('input[type=text]').val(), all);
		return false;
	})
})