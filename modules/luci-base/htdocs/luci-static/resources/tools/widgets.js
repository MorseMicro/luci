'use strict';
'require ui';
'require form';
'require network';
'require firewall';
'require fs';
'require uci';
'require rpc';
'require dom';
'require halow';

const DEFAULT_S1G_COUNTRY = 'US';

function getUsers() {
    return fs.lines('/etc/passwd').then(function(lines) {
        return lines.map(function(line) { return line.split(/:/)[0] });
    });
}

function getGroups() {
    return fs.lines('/etc/group').then(function(lines) {
        return lines.map(function(line) { return line.split(/:/)[0] });
    });
}

var CBIWifiFrequencyValue = form.Value.extend({
	callFrequencyList: rpc.declare({
		object: 'iwinfo',
		method: 'freqlist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		if (this.ucisection) {
			section_id = this.ucisection;
		}

		return Promise.all([
			network.getWifiDevice(section_id),
			this.callFrequencyList(section_id),
			halow.loadChannelMap(),
		]).then(L.bind(function(data) {
			this.halowChannelMap = data[2];
			this.channels = {
				'2g': L.hasSystemFeature('hostapd', 'acs') ? [ 'auto', 'auto', true ] : [],
				'5g': L.hasSystemFeature('hostapd', 'acs') ? [ 'auto', 'auto', true ] : [],
				'6g': [],
				'60g': [],
				's1g': []
			};

			// s1g is a problem because the driver doesn't like telling us information until it's loaded.
			// For now, we just use the channel map.
			// Note that if no s1g channels were added here, we'd also have the issue that
			// s1g would be added to the <select> so that setting band.value to s1g would fail,
			// which leads to defaulting to 11a (see write:).
			if (uci.get('wireless', section_id, 'type') == 'morse') {
				// All our info is in this.halowChannelMap.
				return;
			}

			for (var i = 0; i < data[1].length; i++) {
				var band;

				if (data[1][i].mhz >= 800000 && data[1][i].mhz <= 1000000) {
					// NB these are coming back in khz rather than mhz due
					// to us wanting sub MHz granularity and the netlink
					// command not supporting that.
					data[1][i].mhz /= 1000;
				}

				if (data[1][i].mhz >= 2412 && data[1][i].mhz <= 2484)
					band = '2g';
				else if (data[1][i].mhz >= 5160 && data[1][i].mhz <= 5885)
					band = '5g';
				else if (data[1][i].mhz >= 5925 && data[1][i].mhz <= 7125)
					band = '6g';
				else if (data[1][i].mhz >= 58320 && data[1][i].mhz <= 69120)
					band = '60g';
				else if (data[1][i].mhz >= 800 && data[1][i].mhz <= 1000)
					band = 's1g';
				else
					continue;

				this.channels[band].push(
					data[1][i].channel,
					this.formatChannel(data[1][i].channel, data[1][i].mhz),
					!data[1][i].restricted
				);
			}

			var hwmodelist = L.toArray(data[0] ? data[0].getHWModes() : null)
				.reduce(function(o, v) { o[v] = true; return o }, {});

			this.modes = [
				'', 'Legacy', true,
				'n', 'N', hwmodelist.n,
				'ac', 'AC', hwmodelist.ac,
				'ax', 'AX', hwmodelist.ax
			];

			var htmodelist = L.toArray(data[0] ? data[0].getHTModes() : null)
				.reduce(function(o, v) { o[v] = true; return o }, {});

			this.htmodes = {
				'': [ '', '-', true ],
				'n': [
					'HT20', '20 MHz', htmodelist.HT20,
					'HT40', '40 MHz', htmodelist.HT40
				],
				'ac': [
					'VHT20', '20 MHz', htmodelist.VHT20,
					'VHT40', '40 MHz', htmodelist.VHT40,
					'VHT80', '80 MHz', htmodelist.VHT80,
					'VHT160', '160 MHz', htmodelist.VHT160
				],
				'ax': [
					'HE20', '20 MHz', htmodelist.HE20,
					'HE40', '40 MHz', htmodelist.HE40,
					'HE80', '80 MHz', htmodelist.HE80,
					'HE160', '160 MHz', htmodelist.HE160
				]
			};

			this.bands = {
				'': [
					'2g', '2.4 GHz', this.channels['2g'].length > 3,
					'5g', '5 GHz', this.channels['5g'].length > 3,
					'60g', '60 GHz', this.channels['60g'].length > 0,
					's1g', '< 1GHz', this.channels['s1g'].length > 0,
				],
				'n': [
					'2g', '2.4 GHz', this.channels['2g'].length > 3,
					'5g', '5 GHz', this.channels['5g'].length > 3
				],
				'ac': [
					'5g', '5 GHz', true
				],
				'ax': [
					'2g', '2.4 GHz', this.channels['2g'].length > 3,
					'5g', '5 GHz', this.channels['5g'].length > 3
				]
			};
		}, this));
	},

	setValues: function(sel, vals, displaySingleOption) {
		if (sel.vals)
			sel.vals.selected = sel.selectedIndex;

		while (sel.options[0])
			sel.remove(0);

		for (var i = 0; vals && i < vals.length; i += 3)
			if (vals[i+2])
				sel.add(E('option', { value: vals[i+0] }, [ vals[i+1] ]));

		if (vals && !isNaN(vals.selected))
			sel.selectedIndex = vals.selected;

		if (displaySingleOption) {
			sel.parentNode.style.display = (sel.options.length <= 0) ? 'none' : '';
		} else {
			sel.parentNode.style.display = (sel.options.length <= 1) ? 'none' : '';
		}
		sel.vals = vals;
	},

	// This is usually called from the onchange callback of a CBIWifiCountryValue
	// (there's no country element as part of this widget).
	toggleS1gCountry: function(section_id, country) {
		var elem = this.map.findElement('id', this.cbid(section_id));

		this.updateS1gCountry(elem, country);
		this.updateS1gWidths(elem);

		elem.querySelector('.s1g-width').dispatchEvent(new CustomEvent('change'));
	},

	toggleWifiMode: function(elem) {
		this.updateWifiHTMode(elem);
		this.updateWifiBand(elem);

		this.map.checkDepends();
	},

	toggleWifiS1gWidth: function(elem) {
		this.updateWifiChannel(elem);

		this.map.checkDepends();
	},

	toggleWifiBand: function(elem) {
		this.updateWifiChannel(elem);

		this.map.checkDepends();
	},

	updateS1gCountry: function(elem, country) {
		elem.dataset.country = country;
	},

	updateS1gWidths: function(elem) {
		var s1gWidthEl = elem.querySelector('.s1g-width');
		var s1gWidths = Array.from((new Set(Object.values(this.halowChannelMap[elem.dataset.country]).map(ch => ch.bw))).keys());

		s1gWidths.sort((a, b) => Number(b) - Number(a));
		var s1gWidthsValues = [];
		for (const s1gWidth of s1gWidths) {
			s1gWidthsValues.push(s1gWidth, `${s1gWidth} MHz`, true);
		}

		this.setValues(s1gWidthEl, s1gWidthsValues, true);
	},

	updateWifiHTMode: function(elem) {
		var mode = elem.querySelector('.mode');
		var bwdt = elem.querySelector('.htmode');

		this.setValues(bwdt, this.htmodes[mode.value]);
	},

	updateWifiBand: function(elem) {
		var mode = elem.querySelector('.mode');
		var band = elem.querySelector('.band');

		this.setValues(band, this.bands[mode.value]);
	},

	updateWifiChannel: function(elem, existingChannel) {
		var bandEl = elem.querySelector('.band');
		var chanEl = elem.querySelector('.channel');

		var s1gWidth = elem.querySelector('.s1g-width')?.value;
		if (s1gWidth) {
			const channelValues = [];
			for (const chanInfo of Object.values(this.halowChannelMap[elem.dataset.country])) {
				if (chanInfo.bw === s1gWidth) {
					channelValues.push(chanInfo.s1g_chan, this.formatChannel(chanInfo.s1g_chan, chanInfo.centre_freq_mhz), true);
				}
			}
			this.setValues(chanEl, channelValues, true);

			if (existingChannel) {
				// i.e. after we've initially created the input widget, set the channel
				// to whatever is in UCI.
				chanEl.value = existingChannel;
			}
		} else {
			this.setValues(chanEl, this.channels[bandEl.value]);
		}
	},

	setInitialValues: function(section_id, elem) {
		var mode = elem.querySelector('.mode'),
		    band = elem.querySelector('.band'),
		    chan = elem.querySelector('.channel'),
		    bwdt = elem.querySelector('.htmode'),
		    s1gWidth = elem.querySelector('.s1g-width'),
		    htval = uci.get('wireless', section_id, 'htmode'),
		    hwval = uci.get('wireless', section_id, 'hwmode'),
		    chval = uci.get('wireless', section_id, 'channel'),
		    bandval = uci.get('wireless', section_id, 'band'),
		    country = uci.get('wireless', section_id, 'country'),
		    type = uci.get('wireless', section_id, 'type');

		if (type === 'morse') {
			this.updateS1gCountry(elem, country || DEFAULT_S1G_COUNTRY);
			this.updateS1gWidths(elem);

			// If we have an existing channel, set the bw appropriately
			// and do _not_ trigger change events (it's a load!).
			const bw = this.halowChannelMap[country]?.[chval]?.bw;
			if (bw) {
				s1gWidth.value = bw;
			}

			// This is only to convince 'write' that we're an s1g device.
			this.useBandOption = false;
			this.setValues(band, ['s1g', '< 1GHz', true]);
			band.value = 's1g';

			this.updateWifiChannel(elem, chval);
			this.map.checkDepends();

			return elem;
		}

		this.setValues(mode, this.modes);

		if (/HE20|HE40|HE80|HE160/.test(htval))
			mode.value = 'ax';
		else if (/VHT20|VHT40|VHT80|VHT160/.test(htval))
			mode.value = 'ac';
		else if (/HT20|HT40/.test(htval))
			mode.value = 'n';
		else
			mode.value = '';

		this.toggleWifiMode(elem);

		if (hwval != null) {
			this.useBandOption = false;

			if (/ah/.test(hwval)) {
				band.value = 's1g';
			} else if (/a/.test(hwval))
				band.value = '5g';
			else
				band.value = '2g';
		}
		else {
			this.useBandOption = true;

			band.value = bandval;
		}

		this.toggleWifiBand(elem);

		bwdt.value = htval;
		chan.value = chval || (chan.options[0] ? chan.options[0].value : 'auto');

		return elem;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		// Confusingly, luci constructs the cbid without the overridden section_id
		// from this.ucisection. This is particularly odd since this.transformDepList
		// does do this transform. Seems like a bug to me, but for consistency
		// we retain this behaviour.
		var elem = E('div', {id: this.cbid(section_id)});

		dom.content(elem, [
			E('label', { 'style': 'float:left; margin-right:3px; display:none;' }, [
				_('Mode'), E('br'),
				E('select', {
					'class': 'mode',
					'style': 'width:auto',
					'change': L.bind(this.toggleWifiMode, this, elem),
					'disabled': (this.disabled != null) ? this.disabled : this.map.readonly
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px; display:none;' }, [
				_('Band'), E('br'),
				E('select', {
					'class': 'band',
					'style': 'width:auto',
					'change': L.bind(this.toggleWifiBand, this, elem),
					'disabled': (this.disabled != null) ? this.disabled : this.map.readonly
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px; display:none;' }, [
				_('Width'), E('br'),
				E('select', {
					'class': 's1g-width',
					'style': 'width:auto',
					'change': L.bind(this.toggleWifiS1gWidth, this, elem),
					'disabled': (this.disabled != null) ? this.disabled : this.map.readonly
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px; display:none;' }, [
				_('Channel'), E('br'),
				E('select', {
					'class': 'channel',
					'style': 'width:auto',
					'disabled': (this.disabled != null) ? this.disabled : this.map.readonly
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px; display:none;' }, [
				_('Width'), E('br'),
				E('select', {
					'class': 'htmode',
					'style': 'width:auto',
					'disabled': (this.disabled != null) ? this.disabled : this.map.readonly
				})
			]),
			E('br', { 'style': 'clear:left' })
		]);

		const changeState = {};
		for (const el of elem.querySelectorAll('select')) {
			// Usually, this would be a widget-change event, but we're not backing
			// onto a normal UI element here, so...
			el.addEventListener('change',
				L.bind(this.map.checkDepends, this.map));

			el.addEventListener('change',
				L.bind(this.handleValueChange, this, section_id, changeState));
		}

		return this.setInitialValues(this.ucisection || section_id, elem);
	},

	cfgvalue: function(section_id) {
		if (this.ucisection) {
			section_id = this.ucisection;
		}

		return [
		    uci.get('wireless', section_id, 'htmode'),
		    uci.get('wireless', section_id, 'hwmode') || uci.get('wireless', section_id, 'band'),
		    uci.get('wireless', section_id, 'channel'),
		    // We put country here (and in formvalue) to make sure if the country has changed
		    // this counts for causing handleValueChange.
		    uci.get('wireless', section_id, 'country'),
		];
	},

	formvalue: function(section_id) {
		var node = this.map.findElement('data-field', this.cbid(section_id));

		return [
		    node.querySelector('.htmode').value,
		    node.querySelector('.band').value,
		    node.querySelector('.channel').value,
		    node.dataset.country,
		];
	},

	s1gWidth: function(section_id) {
		if (this.map.root && this.map.root.children.length > 0) {
			return this.map.findElement('data-field', this.cbid(section_id)).querySelector('.s1g-width').value;
		} else {
			var country = uci.get('wireless', section_id, 'country'),
			    channel = uci.get('wireless', section_id, 'channel');
			return this.halowChannelMap[country]?.[channel]?.bw;
		}
	},

	write: function(section_id, value) {
		if (this.ucisection) {
			section_id = this.ucisection;
		}

		uci.set('wireless', section_id, 'htmode', value[0] || null);

		if (this.useBandOption)
			uci.set('wireless', section_id, 'band', value[1]);
		else if (value[1] === 's1g')
			uci.set('wireless', section_id, 'hwmode', '11ah');
		else
			uci.set('wireless', section_id, 'hwmode', (value[1] == '2g') ? '11g' : '11a');

		uci.set('wireless', section_id, 'channel', value[2]);
	},

	formatChannel: function(chanNum, freqMHz) {
		return '%d (%f MHz)'.format(chanNum, freqMHz);
	},
});


var CBIWifiTxPowerValue = form.ListValue.extend({
	callTxPowerList: rpc.declare({
		object: 'iwinfo',
		method: 'txpowerlist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		return this.callTxPowerList(section_id).then(L.bind(function(pwrlist) {
			this.powerval = this.wifiNetwork ? this.wifiNetwork.getTXPower() : null;
			this.poweroff = this.wifiNetwork ? this.wifiNetwork.getTXPowerOffset() : null;

			this.value('', _('driver default'));

			for (var i = 0; i < pwrlist.length; i++)
				this.value(pwrlist[i].dbm, '%d dBm (%d mW)'.format(pwrlist[i].dbm, pwrlist[i].mw));

			return form.ListValue.prototype.load.apply(this, [section_id]);
		}, this));
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var widget = form.ListValue.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
		    widget.firstElementChild.style.width = 'auto';

		dom.append(widget, E('span', [
			' - ', _('Current power'), ': ',
			E('span', [ this.powerval != null ? '%d dBm'.format(this.powerval) : E('em', _('unknown')) ]),
			this.poweroff ? ' + %d dB offset = %s dBm'.format(this.poweroff, this.powerval != null ? this.powerval + this.poweroff : '?') : ''
		]));

		return widget;
	}
});

var CBIWifiCountryValue = form.Value.extend({
	callCountryList: rpc.declare({
		object: 'iwinfo',
		method: 'countrylist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		const s1g = uci.get('wireless', section_id, 'band') == 's1g' || uci.get('wireless', section_id, 'hwmode') == '11ah';

		if (s1g) {
			return halow.loadChannelMap().then(channelMap => {
				// The s1g driver won't come up until we have a valid region, so we can't reliably ask it for a countrylist.
				// Also, 'driver default' isn't a valid option, and iwinfo countrylist gives back '00' (world) as region
				// which is not currently a valid selection.
				for (const countryCode of Object.keys(channelMap)) {
					this.value(countryCode, countryCode);
				}

				return form.Value.prototype.load.apply(this, [section_id]) || DEFAULT_S1G_COUNTRY;
			});
		} else {
			return this.callCountryList(section_id).then(L.bind(function(countrylist) {
				if (Array.isArray(countrylist) && countrylist.length > 0) {
					this.value('', _('driver default'));

					for (var i = 0; i < countrylist.length; i++) {
						this.value(countrylist[i].iso3166, '%s - %s'.format(countrylist[i].iso3166, countrylist[i].country));
					}
				}

				return form.Value.prototype.load.apply(this, [section_id]);
			}, this));
		}
	},

	validate: function(section_id, formvalue) {
		if (formvalue != null && formvalue != '' && !/^[A-Z0-9][A-Z0-9]$/.test(formvalue))
			return _('Use ISO/IEC 3166 alpha2 country codes.');

		return true;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var typeClass = (this.keylist && this.keylist.length) ? form.ListValue : form.Value;
		return typeClass.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
	}
});

var CBIZoneSelect = form.ListValue.extend({
	__name__: 'CBI.ZoneSelect',

	load: function(section_id) {
		return Promise.all([ firewall.getZones(), network.getNetworks() ]).then(L.bind(function(zn) {
			this.zones = zn[0];
			this.networks = zn[1];

			return this.super('load', section_id);
		}, this));
	},

	filter: function(section_id, value) {
		return true;
	},

	lookupZone: function(name) {
		return this.zones.filter(function(zone) { return zone.getName() == name })[0];
	},

	lookupNetwork: function(name) {
		return this.networks.filter(function(network) { return network.getName() == name })[0];
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var values = L.toArray((cfgvalue != null) ? cfgvalue : this.default),
		    isOutputOnly = false,
		    choices = {};

		if (this.option == 'dest') {
			for (var i = 0; i < this.section.children.length; i++) {
				var opt = this.section.children[i];
				if (opt.option == 'src') {
					var val = opt.cfgvalue(section_id) || opt.default;
					isOutputOnly = (val == null || val == '');
					break;
				}
			}

			this.title = isOutputOnly ? _('Output zone') :  _('Destination zone');
		}

		if (this.allowlocal) {
			choices[''] = E('span', {
				'class': 'zonebadge',
				'style': firewall.getZoneColorStyle(null)
			}, [
				E('strong', _('Device')),
				(this.allowany || this.allowlocal)
					? E('span', ' (%s)'.format(this.option != 'dest' ? _('output') : _('input'))) : ''
			]);
		}
		else if (!this.multiple && (this.rmempty || this.optional)) {
			choices[''] = E('span', {
				'class': 'zonebadge',
				'style': firewall.getZoneColorStyle(null)
			}, E('em', _('unspecified')));
		}

		if (this.allowany) {
			choices['*'] = E('span', {
				'class': 'zonebadge',
				'style': firewall.getZoneColorStyle(null)
			}, [
				E('strong', _('Any zone')),
				(this.allowany && this.allowlocal && !isOutputOnly) ? E('span', ' (%s)'.format(_('forward'))) : ''
			]);
		}

		for (var i = 0; i < this.zones.length; i++) {
			var zone = this.zones[i],
			    name = zone.getName(),
			    networks = zone.getNetworks(),
			    ifaces = [];

			if (!this.filter(section_id, name))
				continue;

			for (var j = 0; j < networks.length; j++) {
				var network = this.lookupNetwork(networks[j]);

				if (!network)
					continue;

				var span = E('span', {
					'class': 'ifacebadge' + (network.getName() == this.network ? ' ifacebadge-active' : '')
				}, network.getName() + ': ');

				var devices = network.isBridge() ? network.getDevices() : L.toArray(network.getDevice());

				for (var k = 0; k < devices.length; k++) {
					span.appendChild(E('img', {
						'title': devices[k].getI18n(),
						'src': L.resource('icons/%s%s.png'.format(devices[k].getType(), devices[k].isUp() ? '' : '_disabled'))
					}));
				}

				if (!devices.length)
					span.appendChild(E('em', _('(empty)')));

				ifaces.push(span);
			}

			if (!ifaces.length)
				ifaces.push(E('em', _('(empty)')));

			choices[name] = E('span', {
				'class': 'zonebadge',
				'style': firewall.getZoneColorStyle(zone)
			}, [ E('strong', name) ].concat(ifaces));
		}

		var widget = new ui.Dropdown(values, choices, {
			id: this.cbid(section_id),
			sort: true,
			multiple: this.multiple,
			optional: this.optional || this.rmempty,
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
			select_placeholder: E('em', _('unspecified')),
			display_items: this.display_size || this.size || 3,
			dropdown_items: this.dropdown_size || this.size || 5,
			validate: L.bind(this.validate, this, section_id),
			create: !this.nocreate,
			create_markup: '' +
				'<li data-value="{{value}}">' +
					'<span class="zonebadge" style="background:repeating-linear-gradient(45deg,rgba(204,204,204,0.5),rgba(204,204,204,0.5) 5px,rgba(255,255,255,0.5) 5px,rgba(255,255,255,0.5) 10px)">' +
						'<strong>{{value}}:</strong> <em>('+_('create')+')</em>' +
					'</span>' +
				'</li>'
		});

		var elem = widget.render();

		if (this.option == 'src') {
			elem.addEventListener('cbi-dropdown-change', L.bind(function(ev) {
				var opt = this.map.lookupOption('dest', section_id),
				    val = ev.detail.instance.getValue();

				if (opt == null)
					return;

				var cbid = opt[0].cbid(section_id),
				    label = document.querySelector('label[for="widget.%s"]'.format(cbid)),
				    node = document.getElementById(cbid);

				L.dom.content(label, val == '' ? _('Output zone') : _('Destination zone'));

				if (val == '') {
					if (L.dom.callClassMethod(node, 'getValue') == '')
						L.dom.callClassMethod(node, 'setValue', '*');

					var emptyval = node.querySelector('[data-value=""]'),
					    anyval = node.querySelector('[data-value="*"]');

					L.dom.content(anyval.querySelector('span'), E('strong', _('Any zone')));

					if (emptyval != null)
						emptyval.parentNode.removeChild(emptyval);
				}
				else {
					var anyval = node.querySelector('[data-value="*"]'),
					    emptyval = node.querySelector('[data-value=""]');

					if (emptyval == null) {
						emptyval = anyval.cloneNode(true);
						emptyval.removeAttribute('display');
						emptyval.removeAttribute('selected');
						emptyval.setAttribute('data-value', '');
					}

					if (opt[0].allowlocal)
						L.dom.content(emptyval.querySelector('span'), [
							E('strong', _('Device')), E('span', ' (%s)'.format(_('input')))
						]);

					L.dom.content(anyval.querySelector('span'), [
						E('strong', _('Any zone')), E('span', ' (%s)'.format(_('forward')))
					]);

					anyval.parentNode.insertBefore(emptyval, anyval);
				}

			}, this));
		}
		else if (isOutputOnly) {
			var emptyval = elem.querySelector('[data-value=""]');
			emptyval.parentNode.removeChild(emptyval);
		}

		return elem;
	},
});

var CBIZoneForwards = form.DummyValue.extend({
	__name__: 'CBI.ZoneForwards',

	load: function(section_id) {
		return Promise.all([
			firewall.getDefaults(),
			firewall.getZones(),
			network.getNetworks(),
			network.getDevices()
		]).then(L.bind(function(dznd) {
			this.defaults = dznd[0];
			this.zones = dznd[1];
			this.networks = dznd[2];
			this.devices = dznd[3];

			return this.super('load', section_id);
		}, this));
	},

	renderZone: function(zone) {
		var name = zone.getName(),
		    networks = zone.getNetworks(),
		    devices = zone.getDevices(),
		    subnets = zone.getSubnets(),
		    ifaces = [];

		for (var j = 0; j < networks.length; j++) {
			var network = this.networks.filter(function(net) { return net.getName() == networks[j] })[0];

			if (!network)
				continue;

			var span = E('span', {
				'class': 'ifacebadge' + (network.getName() == this.network ? ' ifacebadge-active' : '')
			}, network.getName() + ': ');

			var subdevs = network.isBridge() ? network.getDevices() : L.toArray(network.getDevice());

			for (var k = 0; k < subdevs.length && subdevs[k]; k++) {
				span.appendChild(E('img', {
					'title': subdevs[k].getI18n(),
					'src': L.resource('icons/%s%s.png'.format(subdevs[k].getType(), subdevs[k].isUp() ? '' : '_disabled'))
				}));
			}

			if (!subdevs.length)
				span.appendChild(E('em', _('(empty)')));

			ifaces.push(span);
		}

		for (var i = 0; i < devices.length; i++) {
			var device = this.devices.filter(function(dev) { return dev.getName() == devices[i] })[0],
			    title = device ? device.getI18n() : _('Absent Interface'),
			    type = device ? device.getType() : 'ethernet',
			    up = device ? device.isUp() : false;

			ifaces.push(E('span', { 'class': 'ifacebadge' }, [
				E('img', {
					'title': title,
					'src': L.resource('icons/%s%s.png'.format(type, up ? '' : '_disabled'))
				}),
				device ? device.getName() : devices[i]
			]));
		}

		if (subnets.length > 0)
			ifaces.push(E('span', { 'class': 'ifacebadge' }, [ '{ %s }'.format(subnets.join('; ')) ]));

		if (!ifaces.length)
			ifaces.push(E('span', { 'class': 'ifacebadge' }, E('em', _('(empty)'))));

		return E('label', {
			'class': 'zonebadge cbi-tooltip-container',
			'style': firewall.getZoneColorStyle(zone)
		}, [
			E('strong', name),
			E('div', { 'class': 'cbi-tooltip' }, ifaces)
		]);
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var value = (cfgvalue != null) ? cfgvalue : this.default,
		    zone = this.zones.filter(function(z) { return z.getName() == value })[0];

		if (!zone)
			return E([]);

		var forwards = zone.getForwardingsBy('src'),
		    dzones = [];

		for (var i = 0; i < forwards.length; i++) {
			var dzone = forwards[i].getDestinationZone();

			if (!dzone)
				continue;

			dzones.push(this.renderZone(dzone));
		}

		if (!dzones.length)
			dzones.push(E('label', { 'class': 'zonebadge zonebadge-empty' },
				E('strong', this.defaults.getForward())));

		return E('div', { 'class': 'zone-forwards' }, [
			E('div', { 'class': 'zone-src' }, this.renderZone(zone)),
			E('span', '⇒'),
			E('div', { 'class': 'zone-dest' }, dzones)
		]);
	},
});

var CBINetworkSelect = form.ListValue.extend({
	__name__: 'CBI.NetworkSelect',

	load: function(section_id) {
		return network.getNetworks().then(L.bind(function(networks) {
			this.networks = networks;

			return this.super('load', section_id);
		}, this));
	},

	filter: function(section_id, value) {
		return true;
	},

	renderIfaceBadge: function(network) {
		var span = E('span', { 'class': 'ifacebadge' }, network.getName() + ': '),
		    devices = network.isBridge() ? network.getDevices() : L.toArray(network.getDevice());

		for (var j = 0; j < devices.length && devices[j]; j++) {
			span.appendChild(E('img', {
				'title': devices[j].getI18n(),
				'src': L.resource('icons/%s%s.png'.format(devices[j].getType(), devices[j].isUp() ? '' : '_disabled'))
			}));
		}

		if (!devices.length) {
			span.appendChild(E('em', { 'class': 'hide-close' }, _('(no interfaces attached)')));
			span.appendChild(E('em', { 'class': 'hide-open' }, '-'));
		}

		return span;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var values = L.toArray((cfgvalue != null) ? cfgvalue : this.default),
		    choices = {},
		    checked = {};

		for (var i = 0; i < values.length; i++)
			checked[values[i]] = true;

		values = [];

		if (!this.multiple && (this.rmempty || this.optional))
			choices[''] = E('em', _('unspecified'));

		for (var i = 0; i < this.networks.length; i++) {
			var network = this.networks[i],
			    name = network.getName();

			if (name == this.exclude || !this.filter(section_id, name))
				continue;

			if (name == 'loopback' && !this.loopback)
				continue;

			if (this.novirtual && network.isVirtual())
				continue;

			if (checked[name])
				values.push(name);

			choices[name] = this.renderIfaceBadge(network);
		}

		var widget = new ui.Dropdown(this.multiple ? values : values[0], choices, {
			id: this.cbid(section_id),
			sort: true,
			multiple: this.multiple,
			optional: this.optional || this.rmempty,
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
			select_placeholder: E('em', _('unspecified')),
			display_items: this.display_size || this.size || 3,
			dropdown_items: this.dropdown_size || this.size || 5,
			datatype: this.multiple ? 'list(uciname)' : 'uciname',
			validate: L.bind(this.validate, this, section_id),
			create: !this.nocreate,
			create_markup: '' +
				'<li data-value="{{value}}">' +
					'<span class="ifacebadge" style="background:repeating-linear-gradient(45deg,rgba(204,204,204,0.5),rgba(204,204,204,0.5) 5px,rgba(255,255,255,0.5) 5px,rgba(255,255,255,0.5) 10px)">' +
						'{{value}}: <em>('+_('create')+')</em>' +
					'</span>' +
				'</li>'
		});

		return widget.render();
	},

	textvalue: function(section_id) {
		var cfgvalue = this.cfgvalue(section_id),
		    values = L.toArray((cfgvalue != null) ? cfgvalue : this.default),
		    rv = E([]);

		for (var i = 0; i < (this.networks || []).length; i++) {
			var network = this.networks[i],
			    name = network.getName();

			if (values.indexOf(name) == -1)
				continue;

			if (rv.length)
				L.dom.append(rv, ' ');

			L.dom.append(rv, this.renderIfaceBadge(network));
		}

		if (!rv.firstChild)
			rv.appendChild(E('em', _('unspecified')));

		return rv;
	},
});

var CBIDeviceSelect = form.ListValue.extend({
	__name__: 'CBI.DeviceSelect',

	load: function(section_id) {
		return Promise.all([
			network.getDevices(),
			this.noaliases ? null : network.getNetworks()
		]).then(L.bind(function(data) {
			this.devices = data[0];
			this.networks = data[1];

			return this.super('load', section_id);
		}, this));
	},

	filter: function(section_id, value) {
		return true;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var values = L.toArray((cfgvalue != null) ? cfgvalue : this.default),
		    choices = {},
		    checked = {},
		    order = [];

		for (var i = 0; i < values.length; i++)
			checked[values[i]] = true;

		values = [];

		if (!this.multiple && (this.rmempty || this.optional))
			choices[''] = E('em', _('unspecified'));

		for (var i = 0; i < this.devices.length; i++) {
			var device = this.devices[i],
			    name = device.getName(),
			    type = device.getType();

			if (name == 'lo' || name == this.exclude || !this.filter(section_id, name))
				continue;

			if (this.noaliases && type == 'alias')
				continue;

			if (this.nobridges && type == 'bridge')
				continue;

			if (this.noinactive && device.isUp() == false)
				continue;

			var item = E([
				E('img', {
					'title': device.getI18n(),
					'src': L.resource('icons/%s%s.png'.format(type, device.isUp() ? '' : '_disabled'))
				}),
				E('span', { 'class': 'hide-open' }, [ name ]),
				E('span', { 'class': 'hide-close'}, [ device.getI18n() ])
			]);

			var networks = device.getNetworks();

			if (networks.length > 0)
				L.dom.append(item.lastChild, [ ' (', networks.map(function(n) { return n.getName() }).join(', '), ')' ]);

			if (checked[name])
				values.push(name);

			choices[name] = item;
			order.push(name);
		}

		if (this.networks != null) {
			for (var i = 0; i < this.networks.length; i++) {
				var net = this.networks[i],
				    device = network.instantiateDevice('@%s'.format(net.getName()), net),
				    name = device.getName();

				if (name == '@loopback' || name == this.exclude || !this.filter(section_id, name))
					continue;

				if (this.noinactive && net.isUp() == false)
					continue;

				var item = E([
					E('img', {
						'title': device.getI18n(),
						'src': L.resource('icons/alias%s.png'.format(net.isUp() ? '' : '_disabled'))
					}),
					E('span', { 'class': 'hide-open' }, [ name ]),
					E('span', { 'class': 'hide-close'}, [ device.getI18n() ])
				]);

				if (checked[name])
					values.push(name);

				choices[name] = item;
				order.push(name);
			}
		}

		if (!this.nocreate) {
			var keys = Object.keys(checked).sort(L.naturalCompare);

			for (var i = 0; i < keys.length; i++) {
				if (choices.hasOwnProperty(keys[i]))
					continue;

				choices[keys[i]] = E([
					E('img', {
						'title': _('Absent Interface'),
						'src': L.resource('icons/ethernet_disabled.png')
					}),
					E('span', { 'class': 'hide-open' }, [ keys[i] ]),
					E('span', { 'class': 'hide-close'}, [ '%s: "%h"'.format(_('Absent Interface'), keys[i]) ])
				]);

				values.push(keys[i]);
				order.push(keys[i]);
			}
		}

		var widget = new ui.Dropdown(this.multiple ? values : values[0], choices, {
			id: this.cbid(section_id),
			sort: order,
			multiple: this.multiple,
			optional: this.optional || this.rmempty,
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
			select_placeholder: E('em', _('unspecified')),
			display_items: this.display_size || this.size || 3,
			dropdown_items: this.dropdown_size || this.size || 5,
			validate: L.bind(this.validate, this, section_id),
			create: !this.nocreate,
			create_markup: '' +
				'<li data-value="{{value}}">' +
					'<img title="'+_('Custom Interface')+': &quot;{{value}}&quot;" src="'+L.resource('icons/ethernet_disabled.png')+'" />' +
					'<span class="hide-open">{{value}}</span>' +
					'<span class="hide-close">'+_('Custom Interface')+': "{{value}}"</span>' +
				'</li>'
		});

		return widget.render();
	},
});

var CBIUserSelect = form.ListValue.extend({
	__name__: 'CBI.UserSelect',

	load: function(section_id) {
		return getUsers().then(L.bind(function(users) {
			delete this.keylist;
			delete this.vallist;
			for (var i = 0; i < users.length; i++) {
				this.value(users[i]);
			}

			return this.super('load', section_id);
		}, this));
	},

	filter: function(section_id, value) {
		return true;
	},
});

var CBIGroupSelect = form.ListValue.extend({
	__name__: 'CBI.GroupSelect',

	load: function(section_id) {
		return getGroups().then(L.bind(function(groups) {
			for (var i = 0; i < groups.length; i++) {
				this.value(groups[i]);
			}

			return this.super('load', section_id);
		}, this));
	},

	filter: function(section_id, value) {
		return true;
	},
});


return L.Class.extend({
	ZoneSelect: CBIZoneSelect,
	ZoneForwards: CBIZoneForwards,
	NetworkSelect: CBINetworkSelect,
	DeviceSelect: CBIDeviceSelect,
	UserSelect: CBIUserSelect,
	GroupSelect: CBIGroupSelect,
	WifiFrequencyValue: CBIWifiFrequencyValue,
	WifiTxPowerValue: CBIWifiTxPowerValue,
	WifiCountryValue: CBIWifiCountryValue,
});
