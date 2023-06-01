'use strict';
'require view';
'require fs';

return view.extend({
	load: function() {
		return fs.exec_direct('/usr/bin/tail', ['-3000', '/var/log/beerocks_agent.log']);
	},

	render: function(logdata) {
		return E([], [
			E('h2', {}, [ _('EasyMesh Agent Log') ]),
			E('div', { 'id': 'content_beerocks_agent' }, [
				E('textarea', {
					'id': 'syslog',
					'style': 'font-size:12px',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': (logdata.match(/\n/g)||[]).length + 1,
				}, logdata)
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
