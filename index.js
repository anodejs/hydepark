var express = require('express');
var http = require('http');
var path = require('path');
var urlParser = require('url');

// Refer global variable anode only if registry is set, to be sure it will not throw.
var rebus = process.env.ANODE_APP && anode && anode.rebus;
var topology = rebus && rebus.value.topology;
var appConfig = rebus && rebus.value.apps && process.env.ANODE_APP && rebus.value.apps[process.env.ANODE_APP];

var srv = express();
var server = http.createServer(srv);
var port = process.env.PORT || 5000;
server.listen(port);

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

var io = require('socket.io').listen(server);

// Peer ANODE instances.
var peers = {};
var inboundPeers = {};

// Clients connect to clients namespace.
var ioclients = io.of('/clients');

// Keep unique name of chat participants
var participants = { me: {} };

// Obtain unique name, given suggested name.
function obtainUniqueName(name) {
  var count = participants.me[name] || 0;
  count++;
  participants.me[name] = count;
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
    socket.broadcast.emit('added', name, 'me');
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
      delete participants.me[name];
      socket.broadcast.emit('removed', name, 'me');
      Object.keys(peers).forEach(function(peerName) {
        peers[peerName].emit('removed', name);
      });
    });
  });
});

// Peer ANODE instances connections
io.of('/peers').on('connection', function(socket) {
  socket.on('authenticate', function(name, nicks) {
    // Other instance identifies itself with instance name.
    console.info('peer inbound connected:', name);
    participants[name] = nicks;
    ioclients.emit('peerconnected', name, nicks);
    // Check if there is no outbound connection to the peer and establish if missing.
    connectToPeer('anodejsrole_IN_' + name);
    if (inboundPeers[name] && (inboundPeers[name] === socket)) {
      console.warn('peer authenticate from the same socket', name);
      return;
    }
    inboundPeers[name] = socket;
    // Upon message from peer server.
    socket.on('message', function (data) {
      data.peer = name;
      // Send message to all the clients on this instance.
      ioclients.emit('message', data);
    });
    socket.on('added', function(nick) {
      participants[name][nick] = 1;
      ioclients.emit('added', nick, name);
    });
    socket.on('removed', function(nick) {
      ioclients.emit('removed', nick, name);
      delete participants[name][nick];
    });
    socket.on('disconnect', function() {
      if (participants[name]) {
        if (inboundPeers[name] && (inboundPeers[name] === socket)) {
          ioclients.emit('peerdisconnected', name);
          console.info('peer inbound disconnected:', name);
        }
        else {
          console.info('disconnect came from different socket for peer:', name);
        }
      }
      else {
        console.warn('no participants for peer:', name);
      }
    });
  });
});

var ioClient = require('socket.io-client');

// Obtain instnace name out of ANODE instance ID. It is the instance serial
// number.
var instanceName = function (instanceId) {
  var match = /^anodejsrole_IN_(\d+)$/.exec(instanceId);
  return match && match[1];
};

// Current instance name.
var serverName = instanceName(instanceId);

var connectToPeer = function(instance) {
  if (instance === instanceId) {
    return;
  }
  var peerName = instanceName(instance);
  if (peers[peerName]) {
    console.info('already has outbound connection to peer:', peerName);
    return;
  }
  var connectTimeout = setTimeout(function() {
    console.warn('10 minutes passed and still no connection to peer, retrying');
    delete peers[peerName];
    connectToPeer(instance);
  }, 600000);
  var ep = {};
  ep.protocol = internalEp.protocol;
  // Has to take new topology.
  ep.hostname = rebus.value.topology.hosts[instance].addr;
  ep.port = internalEp.port;
  ep.pathname = '/peers';
  var url = urlParser.format(ep);
  console.info('init outbound connection to peer:', peerName);
  var options = { 
    resource: ioSocketResource,
    'max reconnection attempts': Infinity,
    'reconnection limit': 120000,
    'reconnection delay' : 6000,
    transports: ['websocket'],
    'try multiple transports': false
  };
  var socket = ioClient.connect(url, options);
  peers[peerName] = socket;
  // Keep socket associated with the peer.
  socket.on('connect', function() {
    console.info('peer outbound connected:', peerName);
    // Let the peer to know this instance name.
    socket.emit('authenticate', serverName, participants.me);
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
  });
  socket.on('reconnect', function() {
    console.info('peer outbound reconnected:', peerName);
  });
  socket.on('disconnect', function() {
    console.info('peer outbound disconnected:', peerName);
  });
  socket.on('reconnecting', function() {
    console.info('peer outbound reconnecting:', peerName);
  });
  socket.on('connecting', function() {
    console.info('peer outbound connecting:', peerName);
  });
  socket.on('reconnect_failed', function() {
    console.error('peer reconnnect failed:', peerName);
  });
  socket.on('connect_failed', function() {
    console.error('peer connnect failed:', peerName);
  });
};

// On start connect to all the peers that can be seen now.
if (topology && topology.hosts) {
  Object.keys(topology.hosts).forEach(connectToPeer);
}