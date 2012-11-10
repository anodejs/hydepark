$(function(){
  var input = $('#input').focus();
  var inputgroup = $('#inputgroup');
  var content = $('#content');
  var connecting = $('#connecting');

  // hide content until name is chosen
  content.hide();
  input.hide();
  
  // Append message author and message text
  var appendMessage = function(author, message) {
    var entry = $('<div>').addClass('span6');
    var row = $('<div>').addClass('row');
    $('<div>').addClass('span4 chatcontent').text(message).prependTo(row);
    $('<div>').addClass('span2 chatcontent').text(author).prependTo(row);
    row.prependTo(entry);
    entry.prependTo(content);
  };

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
      input.val('');
      input.attr('placeholder', 'Type your message');
      // Send the chosen nick name to the server.
      socket.emit('authenticate', nick);
    };
    
    // Message from another user.
    socket.on('message', function (data) {
      appendMessage(data.nick, data.text);
    });

    // Validate the nick name is valid according to local state.
    var validateNick = function(name) {
      return name && (!names[name]);
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
            socket.emit('message', { text: text});
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

    // Change in server state of participants. Some nick names might be blocked now.
    // Update local state to reduce chances of collision.
    socket.on('update', function(participants) {
      names = participants;
      validateInput();
    });

    // Server connected and sent start request, indicating current chat participants.
    socket.on('start', function(participants) {
      names = participants;
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
      connecting.show();
      nick = null;
    });
  });

});