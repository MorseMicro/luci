'use strict';
'require view';
'require uci';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('ttyd'),
			uci.load('uhttpd')
		]);
	},
	render: function() {
		var port = uci.get_first('ttyd', 'ttyd', 'port') || '7681',
			ssl = uci.get_first('ttyd', 'ttyd', 'ssl') || '0',
			url = uci.get_first('ttyd', 'ttyd', 'url_override');
		if (port === '0')
			return E('div', { class: 'alert-message warning' },
					_('Random ttyd port (port=0) is not supported.<br />Change to a fixed port and try again.'));

		if (window.location.protocol === 'https:' && ssl === '0') {

			// Check if http is enabled in uhttpd and redirect_https is disabled
			var http_enabled = (uci.get('uhttpd', 'main', 'listen_http') != null) &&
							(uci.get('uhttpd', 'main', 'listen_http').length > 0) &&
							(uci.get('uhttpd', 'main', 'redirect_https') != '1');

			if (http_enabled) {
				return E('div', { class: 'alert-message warning' }, [
					E('p', {}, _('Security Warning:')),
					E('p', {}, _('HTTP is not encrypted. Your password and data can be read on the network.')),
					E('a', {
						href: 'http://' + window.location.hostname + L.url('admin/services/ttyd'),
					}, _('Click to start HTTP session'))
				]);
			}

			return E('div', { class: 'alert-message warning' }, [
				E('p', {}, _('Current terminal configuration is not allowed over HTTPS.')),
				E('p', {}, [
					_('Turn off HTTPS redirect in '),
					E('a', {
						href: L.url('admin/system/admin/uhttpd'),
					}, _('HTTP(s) Access')),
					_(' settings.')
				])
			]);
		}

		return E('iframe', {
			src: url || ((ssl === '1' ? 'https' : 'http') + '://' + window.location.hostname + ':' + port),
			style: 'width: 100%; min-height: 500px; border: none; border-radius: 3px; resize: vertical;'
		});
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
