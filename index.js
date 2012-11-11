var express = require('express');
var path = require('path');
var urlParser = require('url');

// Refer global variable anode only if registry is set, to be sure it will not throw.
var rebus = process.env.ANODE_APP && anode && anode.rebus;
var topology = rebus && rebus.value.topology;
var appConfig = rebus && rebus.value.apps && process.env.ANODE_APP && rebus.value.apps[process.env.ANODE_APP];

var srv = express.createServer();
var port = process.env.PORT || 5000;
srv.listen(port);

// Obtain intenal endpoint.
var internalUrl = (appConfig && appConfig.endpoints.internal) || ('http://localhost:' + port);
var internalEp = urlParser.parse(internalUrl);
var appPath = internalEp.pathname;
if (appPath && appPath[0] === '/') {
  appPath = appPath.slice(1);
}

var instanceId = topology && rebus.value.topology.instanceId;
var ioSocketResource = appPath + '/socket.io';

srv.use(express.bodyParser());

// Redirect root to index.html
srv.get('/', function (req, res) {
  var rootpath = req.headers['x-farmjs-rootpath'] || '';
  var url = rootpath + '/index.html';
  res.redirect(url);
});

// Return configuration to client
srv.get('/config/?', function(req, res) {
  var rootpath = req.headers['x-farmjs-rootpath'] || '';
  // If application name in the path and not in domain, should use socket.io with 
  // path in resource.
  var resource = rootpath.length > 0 ? ioSocketResource : null;
  // If running in ANODE, should go always to the same instance. Socket.io keeps runtime
  // state.
  var query = instanceId ? '?$inst=' + instanceId : '';
  var config = {
    resource: resource,
    url: '/clients' + query
  };
  console.info('config:', config);
  res.send(config);
});

srv.use(express.static(path.join(__dirname, "static")));

var io = require('socket.io').listen(srv);

// Peer ANODE instances.
var peers = {};

// Clients connect to clients namespace.
var ioclients = io.of('/clients');

// Keep unique name of chat participants
var participants = {};

// Obtain unique name, given suggested name.
function obtainUniqueName(name) {
  var count = participants[name] || 0;
  count++;
  participants[name] = count;
  // If there is collision on name, try appending the count and resolve
  // it as a unique name.
  return count > 1 ? obtainUniqueName(name + count) : name;
}

// Client connections
ioclients.on('connection', function(socket) {
  // Upon connecting, let client to know participants for this instance.
  // This will allow client to let user choosing nick name that doesn't 
  // collide.
  socket.emit('start', participants);
  // Upon suggested user nick name.
  socket.on('authenticate', function(name) {
    console.info('client connected:', name);
    // Resolve unique name from proposed one. Usually would be the same.
    name = obtainUniqueName(name);
    console.info('confirmed name:', name);
    // Confirm unique name to let client to display the right name.
    socket.emit('confirm', name);
    // Notify all clients on new name added, to reduce chances of name
    // collision race.
    ioclients.emit('update', participants);
    socket.broadcast.emit('added', name);
    Object.keys(peers).forEach(function(peerName) {
      peers[peerName].emit('added', name);
    });
    // On message from client.
    socket.on('message', function (data) {
      // The client nick name is in the scope.
      data.nick = name;
      // Broacast message to all the clients.
      socket.broadcast.emit('message', data);
      // If there are peer ANODE instances, send the message to all 
      // servers.
      Object.keys(peers).forEach(function(peerName) {
        peers[peerName].emit('message', data);
      });
    });
    socket.on('disconnect', function() {
      // Remove nick name from the catalog. No need to notify clients.
      // It is not vital to allow reusing name immediately.
      console.info('client disconnected:', name);
      delete participants[name];
      socket.broadcast.emit('removed', name);
      Object.keys(peers).forEach(function(peerName) {
        peers[peerName].emit('removed', name);
      });
    });
  });
});

var peerNickName = function(peer, nick) {
  return peer + ':' + nick;
};

// Peer ANODE instances connections
io.of('/peers').on('connection', function(socket) {
  socket.on('authenticate', function(name, participants) {
    // Other instance identifies itself with instance name.
    console.info('peer inbound connected:', name);
    // 15 sec later check if there is outbound connection to the peer and
    // establish if not.
    setTimeout(function() {
      console.info('check outbound connection to', name);
      connectToPeer('anodejsrole_IN_' + name);
    }, 15000);
    // Upon message from peer server.
    socket.on('message', function (data) {
      // Prepend peer server name to the client nick name.
      data.nick = peerNickName(name, data.nick);
      // Send message to all the clients on this instance.
      ioclients.emit('message', data);
    });
    socket.on('added', function(nick) {
      ioclients.emit('added', peerNickName(name, nick));
    });
    socket.on('removed', function(nick) {
      ioclients.emit('removed', peerNickName(name, nick));
    });
    socket.on('disconnect', function() {
      Object.keys(participants).forEach(function(nick) {
        ioclients.emit('removed', peerNickName(name, nick));
      });
    });
    Object.keys(participants).forEach(function(nick) {
      ioclients.emit('added', peerNickName(name, nick));
    });
  });
});

var instances = (topology && topology.hosts) || {};
var ioClient = require('socket.io-client');

// Obtain instnace name out of ANODE instance ID. It is the instance serial
// number.
var instanceName = function (instanceId) {
  var match = /^anodejsrole_IN_(\d+)$/.exec(instanceId);
  return match && match[1];
};

// Current instance name.
var serverName = instanceName(instanceId);

// Connect to peer instance.
var connectToPeer = function(instance) {
  var peerName = instanceName(instance);
  if (peers[peerName]) {
    console.info('already has connection to the peer:', peerName);
    return;
  }
  var ep = {};
  // Topology might be changed, hence get the latest.
  var instances = rebus.value.topology.hosts;
  // Use internal endpoint and specific IP address.
  ep.protocol = internalEp.protocol;
  ep.hostname = instances[instance].addr;
  ep.port = internalEp.port;
  ep.pathname = '/peers';
  var url = urlParser.format(ep);
  console.info('outbound connecting to peer:', peerName);
  // Use polling transport that so far is the one that works with ANODE.
  var options = { transports: ['xhr-polling'], resource: ioSocketResource };
  var socket = ioClient.connect(url, options);
  // Keep socket associated with the peer.
  socket.on('connect', function() {
    console.info('outbound connected to peer:', peerName);
    peers[peerName] = socket;
    // Let the peer to know this instance name.
    socket.emit('authenticate', serverName, participants);
  });
  socket.on('disconnect', function() {
    console.info('peer disconnected:', peerName);
    // Indicate there is no outbound connection to this peer.
    delete peers[peerName];
  });
};

// Go over all peers and connect to them.
Object.keys(instances).forEach(function(instance) {
  if (instance !== instanceId) {
    connectToPeer(instance);
  }
});
