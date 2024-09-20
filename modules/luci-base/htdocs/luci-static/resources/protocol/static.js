'use strict';
'require form';
'require network';
'require validation';

function isCIDR(value) {
	return Array.isArray(value) || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/(\d{1,2}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(value);
}

function getIPv4SubnetInfo(s, section_id) {
	// Fall back to cfgvalue if formvalue not available in case
	var ipaddr = s.formvalue(section_id, 'ipaddr') ?? s.cfgvalue(section_id, 'ipaddr'),
	    ipaddrs = ipaddr ? L.toArray(ipaddr) : [],
	    netmask = s.formvalue(section_id, 'netmask') ?? s.cfgvalue(section_id, 'netmask'),
	    broadcast = s.formvalue(section_id, 'broadcast') ?? s.cfgvalue(section_id, 'broadcast');

	var firstsubnet = netmask ? ipaddrs[0] + '/' + netmask : ipaddrs.find(a => a.includes('/'));

	if (firstsubnet == null)
		return {};

	var addr_mask = firstsubnet.split('/'),
	    addr = validation.parseIPv4(addr_mask[0]),
	    mask = addr_mask[1];

	if (!isNaN(mask))
		mask = validation.parseIPv4(network.prefixToMask(+mask));
	else
		mask = validation.parseIPv4(mask);

	if (addr == null || mask == null)
		return {};

	var broadcast_default = [
		addr[0] | (~mask[0] >>> 0 & 255),
		addr[1] | (~mask[1] >>> 0 & 255),
		addr[2] | (~mask[2] >>> 0 & 255),
		addr[3] | (~mask[3] >>> 0 & 255)
	].join('.');

	var networkid = [
		addr[0] & mask[0],
		addr[1] & mask[1],
		addr[2] & mask[2],
		addr[3] & mask[3]
	].join('.');

	return {
		ipaddrs: ipaddrs.map(a => a.split('/')[0]),
		netmask: mask.join('.'),
		broadcast, broadcast_default, networkid
	};
}

function validateIPv4SubnetInfo(section_id, value) {
	var opt = this.map.lookupOption('broadcast', section_id),
	    node = opt ? this.map.findElement('id', opt[0].cbid(section_id)) : null,
	    {ipaddrs, netmask, broadcast, broadcast_default, networkid} = getIPv4SubnetInfo(this.section, section_id);

	if (['255.255.255.254', '255.255.255.255'].includes(netmask)) {
		if (node != null)
			node.querySelector('input').removeAttribute('placeholder');

		if (broadcast != null)
			return _('Should not define broadcast address for /31 or /32 subnet');
		else
			return true;
	}

	var bc_input = node?.querySelector('input');
	if (bc_input != null) {
		if (broadcast_default != null)
			bc_input.setAttribute('placeholder', broadcast_default);
		else
			bc_input.removeAttribute('placeholder');
	}

	if (ipaddrs != null) {
		if (ipaddrs.includes(broadcast && broadcast !== '' ? broadcast : broadcast_default))
			return _('IP shouldn\'t be the same as broadcast address');
		if (ipaddrs.includes(networkid))
			return _('IP shouldn\'t be the same as network identifier (first address in subnet)');
	}

	return true;
}

return network.registerProtocol('static', {
	CBIIPValue: form.Value.extend({
		handleSwitch: function(section_id, option_index, ev) {
			var maskopt = this.map.lookupOption('netmask', section_id);

			if (maskopt == null || !this.isValid(section_id))
				return;

			var maskval = maskopt[0].formvalue(section_id),
			    addrval = this.formvalue(section_id),
			    prefix = maskval ? network.maskToPrefix(maskval) : 32;

			if (prefix == null)
				return;

			this.datatype = 'or(cidr4,ipmask4)';

			var parent = L.dom.parent(ev.target, '.cbi-value-field');
			L.dom.content(parent, form.DynamicList.prototype.renderWidget.apply(this, [
				section_id,
				option_index,
				addrval ? '%s/%d'.format(addrval, prefix) : ''
			]));

			var masknode = this.map.findElement('id', maskopt[0].cbid(section_id));
			if (masknode) {
				parent = L.dom.parent(masknode, '.cbi-value');
				parent.parentNode.removeChild(parent);
			}
		},

		renderWidget: function(section_id, option_index, cfgvalue) {
			var maskopt = this.map.lookupOption('netmask', section_id),
			    widget = isCIDR(cfgvalue) ? 'DynamicList' : 'Value';

			if (widget == 'DynamicList') {
				this.datatype = 'or(cidr4,ipmask4)';
				this.placeholder = _('Add IPv4 address…');
			}
			else {
				this.datatype = 'ip4addr("nomask")';
			}

			var node = form[widget].prototype.renderWidget.apply(this, [ section_id, option_index, cfgvalue ]);

			if (widget == 'Value')
				L.dom.append(node, E('button', {
					'class': 'cbi-button cbi-button-neutral',
					'title': _('Switch to CIDR list notation'),
					'aria-label': _('Switch to CIDR list notation'),
					'click': L.bind(this.handleSwitch, this, section_id, option_index)
				}, '…'));

			return node;
		},

		validate: validateIPv4SubnetInfo
	}),

	CBINetmaskValue: form.Value.extend({
		render: function(option_index, section_id, in_table) {
			var addropt = this.section.children.filter(function(o) { return o.option == 'ipaddr' })[0],
			    addrval = addropt ? addropt.cfgvalue(section_id) : null;

			if (addrval != null && isCIDR(addrval))
				return E([]);

			this.value('255.255.255.0');
			this.value('255.255.0.0');
			this.value('255.0.0.0');

			return form.Value.prototype.render.apply(this, [ option_index, section_id, in_table ]);
		},

		datatype: 'ip4addr("true")',
		validate: validateIPv4SubnetInfo
	}),

	CBIGatewayValue: form.Value.extend({
		datatype: 'ip4addr("nomask")',

		render: function(option_index, section_id, in_table) {
			return network.getWANNetworks().then(L.bind(function(wans) {
				if (wans.length == 1) {
					var gwaddr = wans[0].getGatewayAddr();
					this.placeholder = gwaddr ? '%s (%s)'.format(gwaddr, wans[0].getName()) : '';
				}

				return form.Value.prototype.render.apply(this, [ option_index, section_id, in_table ]);
			}, this));
		},

		validate: function(section_id, value) {
			var addropt = this.section.children.filter(function(o) { return o.option == 'ipaddr' })[0],
			    addrval = addropt ? L.toArray(addropt.cfgvalue(section_id)) : null;

			if (addrval != null) {
				for (var i = 0; i < addrval.length; i++) {
					var addr = addrval[i].split('/')[0];
					if (value == addr)
						return _('The gateway address must not be a local IP address');
				}
			}

			return true;
		}
	}),

	CBIBroadcastValue: form.Value.extend({
		datatype: 'ip4addr("nomask")',

		render: function(option_index, section_id, in_table) {
			var {broadcast_default} = getIPv4SubnetInfo(this.section, section_id);
			this.placeholder = broadcast_default;
			return form.Value.prototype.render.apply(this, [ option_index, section_id, in_table ]);
		},

		validate: validateIPv4SubnetInfo
	}),

	getI18n: function() {
		return _('Static address');
	},

	renderFormOptions: function(s) {
		var o;

		s.taboption('general', this.CBIIPValue, 'ipaddr', _('IPv4 address'));
		s.taboption('general', this.CBINetmaskValue, 'netmask', _('IPv4 netmask'));
		s.taboption('general', this.CBIGatewayValue, 'gateway', _('IPv4 gateway'));
		s.taboption('general', this.CBIBroadcastValue, 'broadcast', _('IPv4 broadcast'));

		o = s.taboption('general', form.DynamicList, 'ip6addr', _('IPv6 address'));
		o.datatype = 'ip6addr';
		o.placeholder = _('Add IPv6 address…');
		o.depends('ip6assign', '');

		o = s.taboption('general', form.Value, 'ip6gw', _('IPv6 gateway'));
		o.datatype = 'ip6addr("nomask")';
		o.depends('ip6assign', '');

		o = s.taboption('general', form.Value, 'ip6prefix', _('IPv6 routed prefix'), _('Public prefix routed to this device for distribution to clients.'));
		o.datatype = 'ip6addr';
		o.depends('ip6assign', '');
	}
});
