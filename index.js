const config = require('./config');
var numTries = 0;

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const voiceit2 = require('voiceit2-nodejs');
let myVoiceIt = new voiceit2(config.apiKey, config.apiToken);

const express = require('express')
const bodyParser = require('body-parser');

var Airtable = require('airtable');
Airtable.configure({
  endpointUrl: 'https://api.airtable.com',
  apiKey: config.airTableKey
});
var base = Airtable.base(config.airTableBase);
var table = base('Accounts');

const PORT = process.env.PORT || 80

express()
  .use(bodyParser.urlencoded({extended: true}))
  .use(bodyParser.json())
  .post('/incoming_call', (req, res) => incomingCall(req, res))
  .post('/enroll_or_verify', (req, res) => enrollOrVerify(req, res))
  .post('/enroll', (req, res) => enroll(req, res))
  .post('/process_enrollment', (req, res) => processEnrollment(req, res))
  .post('/verify', (req, res) => verify(req, res))
  .post('/process_verification', (req, res) => processVerification(req, res))
  .listen(PORT, () => console.log(`Listening on port ${ PORT }`))

function incomingCall(req, res) {
  const twiml = new VoiceResponse();
  const phone = removeSpecialChars(req.query.phone);
	
  table.select({
    maxRecords: 1,
    filterByFormula: '{AccountNo}=' + phone
  }).firstPage(function(err, records) {
    if (err) {
      console.error(err);
      return 0;
    }
    /* here we have the record object we can inspect */
    var userId = records[0].fields.VoiceItUserId;
    console.log("cuid - id: " + userId);
    // Check for user in VoiceIt db
    myVoiceIt.checkUserExists({
      userId :userId
    }, async (jsonResponse)=>{
      // User already exists
      if(jsonResponse.exists === true) {
        // Let's provide the caller with an opportunity to enroll by typing `1` on
        // their phone's keypad. Use the <Gather> verb to collect user input
        const gather = twiml.gather({
          action: '/enroll_or_verify',
          numDigits: 1,
          timeout: 3
        });
        twiml.redirect('/enroll_or_verify?digits=TIMEOUT&userId=' + userId);
      } else {
        speak(twiml, "I'm sorry, you don't have a valid voice print account");
      }
	  
      res.type('text/xml');
      res.send(twiml.toString());
    });
  });
};

// Routing Enrollments & Verification
// ------------------------------------
// We need a route to help determine what the caller intends to do.
const enrollOrVerify = async (req, res) => {
	console.log("eov - req: %O", req);
	
  const digits = req.body.digits;
  const twiml = new VoiceResponse();
  const userId = req.query.userId;
  // When the caller asked to enroll by pressing `1`, provide friendly
  // instructions, otherwise, we always assume their intent is to verify.
  if (digits == 1) {
    //Delete User's voice enrollments and re-enroll
    myVoiceIt.deleteAllEnrollments({
      userId: userId,
      }, async (jsonResponse)=>{
        console.log("deleteAllEnrollments JSON: ", jsonResponse.message);
        speak(twiml, "You have chosen to re enroll your voice, you will now be asked to say a phrase three times, then you will be able to log in with that phrase");
        twiml.redirect('/enroll?userId=' + userId);
        res.type('text/xml');
        res.send(twiml.toString());
    });

  } else {
    //Check for number of enrollments > 2
    myVoiceIt.getAllVoiceEnrollments({
      userId: userId
      }, async (jsonResponse)=>{
        speak(twiml, "You have chosen to verify your Voice.");
        console.log("jsonResponse.message: ", jsonResponse.message);
        const enrollmentsCount = jsonResponse.count;
        console.log("enrollmentsCount: ", enrollmentsCount);
        if(enrollmentsCount > 2){
          twiml.redirect('/verify?userId=' + userId);
          res.type('text/xml');
          res.send(twiml.toString());
        } else{
          speak(twiml, "You do not have enough enrollments and need to re enroll your voice.");
          //Delete User's voice enrollments and re-enroll
          myVoiceIt.deleteAllEnrollments({
            userId: userId,
            }, async (jsonResponse)=>{
              console.log("deleteAllEnrollments JSON: ", jsonResponse.message);
              twiml.redirect('/enroll?userId=' + userId);
              res.type('text/xml');
              res.send(twiml.toString());
          });
        }
    });
  }
};

// Enrollment Recording
const enroll = async (req, res) => {
  const enrollCount = req.query.enrollCount || 0;
  const twiml = new VoiceResponse();
  speak(twiml, 'After the beep, please say the following phrase to enroll ');
  speak(twiml, 'Never forget tomorrow is a new day');

	console.log("user id: " + req.query.userId + ", enrollCount: " + enrollCount);
	
  twiml.record({
    action: '/process_enrollment?userId=' + req.query.userId + '&enrollCount=' + enrollCount,
    maxLength: 5,
    trim: 'do-not-trim'
  });
  res.type('text/xml');
  res.send(twiml.toString());
};

// Process Enrollment
const processEnrollment = async (req, res) => {
  const userId = req.query.userId;
  var enrollCount = req.query.enrollCount;
  const recordingURL = req.body.RecordingUrl + ".wav";
  const twiml = new VoiceResponse();

  function enrollmentDone(){
      enrollCount++;
      // VoiceIt requires at least 3 successful enrollments.
      if (enrollCount > 2) {
        speak(twiml, 'Thank you, recording received, you are now enrolled and ready to verify your voice');
        twiml.redirect('/verify?userId=' + userId);
      } else {
        speak(twiml, 'Thank you, recording received, you will now be asked to record your phrase again');
        twiml.redirect('/enroll?userId=' + userId + '&enrollCount=' + enrollCount);
      }
  }

  function enrollAgain(){
    speak(twiml, 'Your recording was not successful, please try again');
    twiml.redirect('/enroll?enrollCount=' + enrollCount);
  }

  // Sleep and wait for Twillio to make file available
  await new Promise(resolve => setTimeout(resolve, 500));
  myVoiceIt.createVoiceEnrollmentByUrl({
    userId: userId,
	  audioFileURL: recordingURL,
    phrase: 'Never forget tomorrow is a new day',
	  contentLanguage: "en-GB",
	}, async (jsonResponse)=>{
      console.log("createVoiceEnrollmentByUrl json: ", jsonResponse.message);
      if ( jsonResponse.responseCode === "SUCC" ) {
        enrollmentDone();
      } else {
        enrollAgain();
      }

    res.type('text/xml');
    res.send(twiml.toString());
  });
}

// Verification Recording
const verify = async (req, res) => {
  var twiml = new VoiceResponse();

  speak(twiml, 'Please say the following phrase after the beep to verify your voice ');
  speak(twiml, 'Never forget tomorrow is a new day');

  twiml.record({
    action: '/process_verification?userId=' + req.query.userId,
    maxLength: '5',
    trim: 'do-not-trim',
  });
  res.type('text/xml');
  res.send(twiml.toString());
};

// Process Verification
const processVerification = async (req, res) => {
  const userId = req.query.userId;
  const recordingURL = req.body.RecordingUrl + '.wav';
  const twiml = new VoiceResponse();

  // Sleep and wait for Twillio to make file available
  await new Promise(resolve => setTimeout(resolve, 1000));
  myVoiceIt.voiceVerificationByUrl({
    userId: userId,
  	audioFileURL: recordingURL,
    phrase: 'Never forget tomorrow is a new day',
  	contentLanguage: "en-GB",
  	}, async (jsonResponse)=>{
      console.log("createVoiceVerificationByUrl: ", jsonResponse.message);

      if (jsonResponse.responseCode == "SUCC") {
        speak(twiml, 'Verification successful!');
	twiml.redirect('https://webhooks.twilio.com/v1/Accounts/' + req.body.AccountSid + '/Flows/' + config.twilioFlow + '?FlowEvent=return');
        //Return to Twilio Flow
      } else if (numTries > 2) {
        //3 attempts failed
        speak(twiml,'Too many failed attempts. Please call back and select option 1 to re enroll and verify again.');
	twiml.redirect('https://webhooks.twilio.com/v1/Accounts/' + req.body.AccountSid + '/Flows/' + config.twilioFlow + '?FlowEvent=failed');

      } else {
        switch (jsonResponse.responseCode) {
          case "STTF":
              speak(twiml, "Verification failed. It seems you may not have said your enrolled phrase. Please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "FAIL":
              speak(twiml,"Your verification did not pass, please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "SSTQ":
              speak(twiml,"Please speak a little louder and try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "SSTL":
              speak(twiml,"Please speak a little quieter and try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          default:
              speak(twiml,"Something went wrong. Your verification did not pass, please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
          }
      }
      res.type('text/xml');
      res.send(twiml.toString());
  });

};

function speak(twiml, textToSpeak, contentLanguage = "en-GB"){
  twiml.say(textToSpeak, {
    voice: "alice",
    language: contentLanguage
  });
}

function removeSpecialChars(text){
  return text.replace(/[^0-9a-z]/gi, '');
}
