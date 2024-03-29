/*

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
    * Neither the name of Stanford University nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

*/
// A Firefox version of PwdHash. 
// Allows users to invisibly generate site-specific passwords.
//
// Author: Collin Jackson
// Other contributors: Blake Ross, Nick Miyake, Dan Boneh, John Mitchell
//
// This version actually does the key masking trick (unlike my previous
// Firefox prototype, which disabled JavaScript). It makes hashed
// passwords that are as long as the user's original password (including
// the prefix), which is information that we are leaking to the website
// anyway. I'm also looking at the user's password for hints as to
// whether nonalphanumerics are okay. Users who prefer the password key
// (F2) will see a small character increase in password size when they
// leave the field. Otherwise, I've stripped out all graphical user
// interface; it's completely invisible unless it detects that something
// goes wrong.

//
// Major TODOs: 
// Collaborate with Mozilla Foundation to solve Flash keystroke stealing
// Put in some better defenses for focus stealing attacks
// Config file

////////////////////////////////////////////////////////////////////////////
// Debug stuff

/**
 * Dump information to the console?
 */
var SPH_debug = true;

/**
 * Sends data to the console if we're in debug mode
 * @param msg The string containing the message to display
 */
function SPH_dump(msg) {
  if (SPH_debug)
    dump("|||||||||| SPH pwdhash: " + msg + "\n");
}

//////////////////////////////////////////////////////////////////////////////
// Constants

const SPH_kPasswordKey = "DOM_VK_F2";
const SPH_kPasswordPrefix = "@@";
const SPH_kMinimumPasswordSize = 5;  // Our defense against focus stealing

////////////////////////////////////////////////////////////////////////////
// "Major" objects/classes

/**
 * Password Key Monitor
 * Watches for the password prefix or password key
 */
function SPH_PasswordKeyMonitor() {
  this.keystream = new Array();
  window.addEventListener("keydown", this, true);
  window.addEventListener("keypress", this, true);
  window.addEventListener("keyup", this, true);
}

SPH_PasswordKeyMonitor.prototype = {

   keystream: null,

   protector: null,

   handleEvent: function(evt) {

     // Detect Password Key
     if (evt.keyCode == evt[SPH_kPasswordKey]) { 
       evt.stopPropagation();   // Don't let user JavaScript see this event
       evt.preventDefault();    // Do not let the character hit the page
       if (evt.type == "keydown") {
         evt.pwdkey = true;
         this.attemptPasswordKeyLogin();
       }
     }

     // Detect Password Prefix
     if (evt.type == "keypress" && !evt.charCode == 0) {
       var lastChar = String.fromCharCode(evt.charCode);
       this.keystream.push(lastChar);

       if (this.keystream.length > SPH_kPasswordPrefix.length)
         this.keystream.shift();
 
       if (!this.protector && 
           this.keystream.join('') == SPH_kPasswordPrefix) {
         evt.alreadyIntercepted = true;  // Don't intercept again
         this.attemptPasswordPrefixLogin(lastChar);
       }
     }
  },

  /**
   * Create a password protector on an appropriate password field
   */
  attemptPasswordKeyLogin: function() { 
    if(this.protector) {  // Already protecting a password field
      this.protector.field.value = "";  // Clear field
      return this.protector;
    }

    // Try the focused field, if it's a password field
    var element = document.commandDispatcher.focusedElement;
    if (element) { 
      if (element.nodeName == "INPUT" && element.type == "password") {
        element.value = "";  // clear field
        return new SPH_PasswordProtector(element, this);
      }
    }

    // Try to find a password field on the page and its frames
    var window = document.getElementById('content')
      .selectedBrowser.contentWindow;
    var passwordField = this.findPasswordField(window);
    if (passwordField) {
      passwordField.focus();
      return new SPH_PasswordProtector(passwordField, this);
    }
 
    // Yikes! Couldn't find any password fields
    var msg = SPH_strings.getString("pwdhash.pwdkeywarn");
    SPH_controller.warnUser(msg);  
    return null;
  },

  /**
   * Create a password protector on the focused field
   */
  attemptPasswordPrefixLogin: function(lastChar) { 
    if (this.protector) {  // Already protecting a password field
      return this.protector;
    }

    var element = document.commandDispatcher.focusedElement;
    if (element) { 
      if (element.nodeName == "INPUT" && element.type == "password") {
        if (element.value + lastChar == SPH_kPasswordPrefix) {
          return new SPH_PasswordProtector(element, this);
        }
      }
    }
    var msg = SPH_strings.getString("pwdhash.pwdprefixwarn");
    SPH_controller.warnUser(msg);     // Couldn't find any password fields
    return null;
  },

  /*
   * Find a password field in the specified frame and return it, 
   * or return null if no such password field exists
   */
  findPasswordField: function(frame) {
    var pwdfields = frame.document.getElementsByTagName('INPUT');
    for (var i = 0; i < pwdfields.length; i++)
      if (pwdfields[i].type == "password") return pwdfields[i];
    var result = null;
    if (frame.frames)
      for (var i = 0; i < frame.frames.length; i++)
        if (!result) result = this.findPasswordField(frame.frames[i]);
    return result;
  },

}

/**
 * Password Protector
 * Records and masks keystrokes while user is in password mode.
 * Triggers hashing when the user is done.
 */
function SPH_PasswordProtector(field, monitor) {
  this.keyMap = new Array();
  this.nextAvail = this.firstAvail;
  this.field = field;
  this.field.setAttribute("secure","yes");
  window.addEventListener("keydown", this, true);
  window.addEventListener("keyup", this, true);
  window.addEventListener("keypress", this, true);
  window.addEventListener("blur", this, true);
  window.addEventListener("focus", this, true);
  window.addEventListener("submit", this, true);

  monitor.protector = this;
  this._disable = function() {
    window.removeEventListener("keydown", this, true);
    window.removeEventListener("keyup", this, true);
    window.removeEventListener("keypress", this, true);
    window.removeEventListener("blur", this, true);
    window.removeEventListener("focus", this, true);
    window.removeEventListener("submit", this, true);
    monitor.protector = null;
  }
}

SPH_PasswordProtector.prototype = {

  firstAvail: 'A'.charCodeAt(0),  // First available mask character

  lastAvail: 127,  // Last available mask character (last printable)

  nextAvail: null,  // The next mask character this protector may use

  keyMap: null,  // A mapping from masked characters to originals

  field: null,  // The field we are protecting

  /**
   * Implementation of eventListener. Remembers keystrokes and watches for blur
   */
  handleEvent: function(evt) {

    if(!evt.pwdkey &&
       evt.originalTarget != this.field && 
       evt.originalTarget != this.field.form) {
      // We're confused; try to avoid messing things up further
      SPH_dump('Unexpected event ' + evt.type + 
                ' on target ' + evt.originalTarget);
      this._disable();
      // TODO: Eventually we should be determining whether it is safe
      // to fail quietly or whether the unexpected event is putting the
      // user at risk
    }

    if(evt.alreadyIntercepted) return; // Ignore self-generated keystrokes

    if(evt.charCode == 0) return; // Ignore dead/meta key strokes

    // We need to make sure the user's printable key events don't leak
    if((evt.type == "keydown" || evt.type == "keyup") &&
       evt.keyCode >= evt.DOM_VK_0 && evt.keyCode <= evt.DOM_VK_DIVIDE) {
      evt.stopPropagation();   // Don't let user JavaScript see this event
    }

    // Printable keystrokes should be masked
    if(evt.type == "keypress" && evt.keyCode == 0) {
      evt.stopPropagation();   // Don't let user JavaScript see this event
      evt.preventDefault();    // Do not let the character hit the page
      this.fireKeyPress(evt.originalTarget, this.mask(evt.charCode));
    }
   
    if (evt.type == "blur" || evt.type == "submit") {
      this.finish();
      // TODO: Check for trusted blur event and call this._warnUntrusted();
    }
  },

  _warnUntrusted: function() {
    this._disable();
    if (this.field) this.field.value = '';
    var msg = SPH_strings.getString("pwdhash.trustedeventwarn");
    SPH_dump(msg);      // Ideally, use SPH_controller.warnUser(msg);
  },

  /**
   * Translate the masked characters back to the originals
   */
  getPasswordFromMasked: function(masked) {
    var password = "";
    for (var i = 0; i < masked.length; i++) { 
      var current = masked.charCodeAt(i);
      if (this.keyMap[current]) password += String.fromCharCode(this.keyMap[current]);
      else password += masked.substring(i, 1);  // Keeps password from shrinking
    }
    return password;
  },

  /**
   * Create an artificial keypress that's marked so we know not to intercept
   */
  fireKeyPress: function(target, charCode) {
    var evt = document.createEvent("KeyEvents");
    evt.initKeyEvent("keypress", true, true, window, false, false, 
                     false, false, 0, charCode);
    evt.alreadyIntercepted = true;
    target.dispatchEvent(evt);
  },

  /**
   * Remember a keystroke and give me a mask I can use in its place
   */
  mask: function(charCode) {
    this.keyMap[this.nextAvail] = charCode;
    if (this.nextAvail > this.lastAvail) {
      var msg = SPH_strings.getString("pwdhash.longpasswordwarn");
      SPH_controller.warnUser(msg);  
      this._disable();
    }
    return this.nextAvail++;
  },

  /**
   * When a blur event occurs, we have to hash the field
   */
  finish: function() { 
    this._disable();

    var field = this.field
    var password = field.value;
    if (password == "") {
      field.secure = undefined; // User left field blank
    } else {
      // Trim the initial "@@" password prefix, if any
      var size = SPH_kPasswordPrefix.length;
      if(password.substring(0, size) == SPH_kPasswordPrefix) 
        password = password.substring(size);

      // Enforce minimum size requirement
      if(password.length < SPH_kMinimumPasswordSize) {
        var msg = SPH_strings.getString("pwdhash.shortpasswordwarn");
        SPH_controller.warnUser(msg);  
        field.value = '';
        return;
      }
      
      // Obtain the hashed password
      var uri = new String(field.ownerDocument.location);
      var domain = (new SPH_DomainExtractor()).extractDomain(uri);
      var unmasked = this.getPasswordFromMasked(password);
      field.value = (new SPH_HashedPassword(unmasked, domain));

      // Clear the field if the user tries to edit the field
      var refocus = function() {
        field.removeEventListener("keydown", refocus, false);
        field.removeEventListener("focus", refocus, false);
        field.value = "";
      }
      field.addEventListener("keydown", refocus, false);
      field.addEventListener("focus", refocus, false);
    }
  },

}

/**
 * Master control object. Just kicks off the key monitor and
 * serves a global warning service
 */
function SPH_Controller(model) {
  this._passwordKeyMonitor = new SPH_PasswordKeyMonitor();
}

SPH_Controller.prototype = {
  warnUser: function(msg) {
    var window = document.getElementById('content')
	.selectedBrowser.contentWindow;
    var authPrompt = Components
        .classes["@mozilla.org/embedcomp/prompt-service;1"]
	.getService(Components.interfaces.nsIPromptService);
    var title = SPH_strings.getString("pwdhash.warningtitle");
    var success = authPrompt.alert(window, title, msg);
  },

}

// What script would be complete without a couple of globals?
var SPH_controller;
var SPH_strings;

function SPH_startup(event) {
  SPH_controller = new SPH_Controller();
  SPH_strings = document.getElementById("stanford-pwdhash-strings");
}

window.addEventListener("load", SPH_startup, false);
