$(function(){
  var input = $('#input').focus();
  var inputgroup = $('#inputgroup');
  var content = $('#content');
  var connecting = $('#connecting');
  var participantspane =$('#participantspane');
  var participants = $('#participants');

  // hide content until name is chosen
  content.hide();
  input.hide();
  participantspane.hide();
  
  // Append message author and message text
  var appendMessage = function(author, message) {
    var entry = $('<div>').addClass('chatentry');
    var row = $('<div>').addClass('row');
    $('<div>').addClass('span2 chatitem').text($.format.date(new Date(), 'MMM dd HH:mm:ss')).prependTo(row);
    $('<div>').addClass('span4 chatitem').text(message).prependTo(row);
    $('<div>').addClass('span2 chatitem').text(author).prependTo(row);
    row.prependTo(entry);
    entry.prependTo(content);
    entry.show('fast');
  };

  var participantsDisplayed = {};

  var addParticipant = function(nick) {
    var entry = $('<div>').addClass('chatentry');
    var row = $('<div>').addClass('row');
    $('<div>').addClass('span2 chatitem').text(nick).prependTo(row);
    row.prependTo(entry);
    entry.prependTo(participants);
    entry.show('fast');
    participantsDisplayed[nick] = entry;
  }

  var removeParticipant = function(nick) {
    var entry = participantsDisplayed[nick];
    if (entry) {
      entry.remove();
    }
  }

  // Nick names that are reservied for other users.
  var names = {};

  // Get server configuration.
  $.get('config', function(config) {
    config = config || { url: '/' };
    
    // Meanwhile, this is the only transport working with ANODE
    var options = { transports: ['xhr-polling'] };
    // If non-default socket.io resouce, use it.
    if (config.resource) {
      options.resource = config.resource;
    }
    // Connect to the server.
    var socket = io.connect(config.url, options);
    var nick;

    // Set the the chosen nick name.
    var setNick = function() {
      // Now the content can be used.
      content.show();
      participantspane.show();
      input.val('');
      input.attr('placeholder', 'Type your message');
      // Send the chosen nick name to the server.
      socket.emit('authenticate', nick);
    };

    var nickDisplayName = function(nick, peer) {
      var displayName = nick;
      if (peer && peer !== 'me') {
        displayName = peer + ':' + nick;
      }
      return displayName;
    };
    
    // Message from another user.
    socket.on('message', function (data) {
      appendMessage(nickDisplayName(data.nick, data.peer), data.text);
    });

    // Validate the nick name is valid according to local state.
    var validateNick = function(name) {
      return name && (!names.me[name]) && (!(/^(\d+):/.test(name)));
    };

    // Validate current input.
    var validateInput = function() {
      if (nick) {
        // Input for messages is always valid. Validating only nick.
        return;
      }
      // Add or remove error indication according to input state.
      if (validateNick(input.val())) {
        inputgroup.removeClass('error');
      }
      else {
        inputgroup.addClass('error'); 
      }
    };

    // When key is up, the input value is the latest input.
    input.keyup(function(key) {
      var text = input.val();
      switch(key.keyCode) {
        // After 'Ender'
        case 13:
          // If empty box, do nothing.
          if (text) {
            if (!nick) {
              // Nick name is not yet chosen.
              if (!validateNick(text)) {
                // For invalid nick, do nothing. Wait for user
                // specifying a valid nick.
                return;
              }
              // This nick is good. Start using it.
              nick = text;
              return setNick();  
            }
            // If this is message, send it and display locally.
            input.val('');
            appendMessage(nick, text);
            socket.emit('message', { text: text });
          }
          break;
        default:
          // On any other key, validate input to indicate status (e.g. error state)
          validateInput();
      }
    });

    // When unique nick confirmed, use the confirmed value. Usually it would be 
    // the same.
    socket.on('confirm', function(name) {
      nick = name;
    });

    socket.on('added', function(name, peer) {
      names[peer] = names[peer] || {};
      names[peer][name] = 1;
      addParticipant(nickDisplayName(name, peer));
      validateInput();
    });

    socket.on('removed', function(name, peer) {
      removeParticipant(nickDisplayName(name, peer));
      delete names[peer][name];
    });

    // Server connected and sent start request, indicating current chat participants.
    socket.on('start', function(nicks) {
      names = nicks;
      Object.keys(names).forEach(function(peer){
        Object.keys(names[peer]).forEach(function(nick) {
          addParticipant(nickDisplayName(nick, peer));
        });
      });
      // Hide "connecting..." message and ask for a nick from the user.
      connecting.hide();
      input.show();
      if (!nick) {
        input.attr('placeholder', 'Type nick name');
        validateInput();
      }
      else {
        setNick();
      }
    });

    // Upon disconnect, return to connecting state. Wait for 'start' event.
    socket.on('disconnect', function() {
      content.hide();
      input.hide();
      participantspane.hide();
      participants.empty();
      connecting.show();
      names = {};
      nick = null;
    });
  });

});