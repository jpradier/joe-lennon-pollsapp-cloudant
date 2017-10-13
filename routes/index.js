var db;
var cloudant;
var dbCredentials = { dbName: 'pollsappdb'};
var fs = require('fs');

function getDBCredentialsUrl(jsonData) {
    var vcapServices = JSON.parse(jsonData);
    // Pattern match to find the first instance of a Cloudant service in
    // VCAP_SERVICES. If you know your service key, you can access the
    // service credentials directly by using the vcapServices object.
    for (var vcapService in vcapServices) {
        if (vcapService.match(/cloudant/i)) {
            return vcapServices[vcapService][0].credentials.url;
        }
    }
}

function initDBConnection() {
    //When running on Bluemix, this variable will be set to a json object
    //containing all the service credentials of all the bound services
    if (process.env.VCAP_SERVICES) {
        dbCredentials.url = getDBCredentialsUrl(process.env.VCAP_SERVICES);
    } else { //When running locally, the VCAP_SERVICES will not be set

        // When running this app locally you can get your Cloudant credentials
        // from Bluemix (VCAP_SERVICES in "cf env" output or the Environment
        // Variables section for an app in the Bluemix console dashboard).
        // Once you have the credentials, paste them into a file called vcap-local.json.
        // Alternately you could point to a local database here instead of a
        // Bluemix service.
        // url will be in this format: https://username:password@xxxxxxxxx-bluemix.cloudant.com
        dbCredentials.url = getDBCredentialsUrl(fs.readFileSync("vcap-local.json", "utf-8"));
    }

    cloudant = require('cloudant')(dbCredentials.url);

    // check if DB exists if not create
    cloudant.db.create(dbCredentials.dbName, function(err, res) {
        if (err) {
            console.log('Could not create new db: ' + dbCredentials.dbName + ', it might already exist.');
        }
    });

    db = cloudant.use(dbCredentials.dbName);
}

initDBConnection();
//console.log("Hello World");
//db.find({ "selector": { "_id": { "$gt": 0 } }, "fields": [ "_id", "question" ] }, function(err, result) {
//	 if (!err) {
//		 console.log(result.docs);
//	}
//})
//db.get('84fa7414f0c93392d71ba313c6db9e19', function(err, poll) {
//	console.log(poll);
//})

// Main application view
exports.index = function(req, res) {
	res.render('index', { title: 'Polls' });
};

//JSON API for list of polls
exports.list = function(req, res) {
	db.find({ "selector": { "_id": { "$gt": 0 } }, "fields": [ "_id", "question" ] }, function(error, result) {
		res.json(result.docs);
	});
};
//JSON API for getting a single poll
exports.poll = function(req, res) {
	// Poll ID comes in the URL
	var pollId = req.params.id;

	// Find the poll by its ID, use lean as we won't be changing it	
	db.get(pollId, function(err, poll) {
		if(poll) {
			var userVoted = false,
				userChoice,
				totalVotes = 0;
			
			for(c in poll.choices) {
				var choice = poll.choices[c];
				for(v in choice.votes) {
					var vote = choice.votes[v];
					totalVotes++;
					if(vote.ip === (req.header('x-forwarded-for') || req.ip)) {
						userVoted = true;
						userChoice = {
							_id: choice._id,
							text: choice.text
						};
					}
				}
			}
			
			// Attach info about user's past voting on this poll
			poll.userVoted = userVoted;
			poll.userChoice = userChoice;

			poll.totalVotes = totalVotes;
			res.json(poll);
		} else {
			res.json({error:true});
		}
	});
};

// JSON API for creating a new poll
exports.create = function(req, res) {
	var reqBody = req.body,
		choices = reqBody.choices.filter(function(v) {return v.text != '';}),
		pollObj = {question: reqBody.question, choices: choices};
	
	db.insert(pollObj, function(err, doc) {
		if(err || !doc) {
			throw 'Error';
		} else {
			res.json(doc);
		}
	});
};

// Socket API for saving the vote
exports.vote = function(socket) {
	socket.on('send:vote', function(data) {
		var ip = socket.handshake.headers['x-forwarded-for']
				|| socket.handshake.address.address;

		
		db.get(data.poll_id, function(err, poll) {
			var choice = poll.choices[data.choice];
			if (!choice.votes) { choice.votes = []; }
			choice.votes.push({
				ip : ip
			});

			db.insert(poll, { include_docs : true }, function(err, res) {
				if (!err) {
					db.get(res.id, function(err, poll) {
						if (poll) {
							var theDoc = {
								question : poll.question,
								_id : poll._id,
								choices : poll.choices,
								userVoted : false,
								totalVotes : 0
							};
			
							// Loop through poll choices to determine if user has voted
							// on this poll, and if so, what they selected
							for (var i = 0, ln = theDoc.choices.length; i < ln; i++) {
								var choice = theDoc.choices[i];
			
								for (var j = 0, jLn = (choice.votes ? choice.votes.length : 0); j < jLn; j++) {
									var vote = choice.votes[j];
									theDoc.totalVotes++;
									theDoc.ip = ip;
			
									if (vote.ip === ip) {
										theDoc.userVoted = true;
										theDoc.userChoice = {
											_id : choice._id,
											text : choice.text
										};
									}
								}
							}
			
							socket.emit('myvote', theDoc);
							socket.broadcast.emit('vote', theDoc);
						}
					});
				}
			});
		});
	});
};
