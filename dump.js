/**
 * @license AGPLv3 2014
 * @author indolering
 */


var _ = require('underscore');
var cradle = require('cradle');
var db = new (cradle.Connection)().database('bit');
var sugar = require('sugar');
Object.extend();
var DEBUG = true;
var namesTotal = 90000;
//TODO get from server
var scraped = 0;
var batchSize = 100;
var time = Date.now();
var namesRegex = '^d/[a-z][a-z0-9-]{0,61}[a-z0-9]$';
var Promise = require('es6-promise').Promise;
var lastBlockCount = null;
var blockCount = null;
var nmc;
var lockFile = require('lockfile');
var winston = require('winston');
winston.add(winston.transports.File, { filename: 'dumpjs.log' });


// opts is optional, and defaults to {}
lockFile.lock('dump.lock', {stale:3600000}, function (er) {
  if (er) {
    winston.warn('Could not open lockfile!' + new Date().toISOString());
  } else {

var namecoind = require('./nmc').init().then(function(nmcd){

nmc = nmcd;

nmc.blockCount().then(function(value) {
  blockCount = value;
  db.get('$lastBlockCount', function(err, doc) {
    if (err) {
      lastBlockCount = blockCount - 36000; //all current blocks
      db.save('$lastBlockCount', {"blocks": blockCount});
    } else {
      if (doc.blocks < 36000) {
        lastBlockCount = blockCount - 36000;
      } else {
        lastBlockCount = doc.blocks - 6; //1 "hour" overlap between calls
      }
      db.save('$lastBlockCount', doc._rev, {"blocks": blockCount});
    }

    nmc.filter({regex: namesRegex, age: blockCount - lastBlockCount, start: 0, max: 0, stat: true})
      .then(function(result) {
        namesTotal = result.count;
        nameDump();
      });
  });

});
});
  }
});


function expireBlock(expires) {
  return blockCount + expires;
}

function cleanRecord(record) {
  var name = record.name;
  var value = record.value;

  if (name.startsWith('d/')) {
    name = name.from(2);
  }

  if (value === "RESERVED") {
    value = '{"$reserved":true}';
  }

  if (!value.isBlank() && value.has(/[{}:]/)) { //sanity check to reduce error log
    try {
      value = JSON.parse(value);
      value['expires'] = expireBlock(record.expires_in);

    } catch (e) {
//      value = {'$error' : encodeURI(value)};
//      console.log(e, name, value);
      return false;
    }
  } else {
    return false;
  }
  return {name: name, value: value};
}

// removes all admins stuff
// will (eventually) also remove all key/values which are not well formed.
function scrubRecord(record) {
  if (!record.value.isObject()) {
    record = cleanRecord(record);
  }

  if (record) {
    var keys = Object.keys(record.value);


    for (var i = 0; i < keys.length; i++) {
      if (keys[i].startsWith('_') || keys[i].startsWith('$')) {
        delete record[keys[i]];
      }
    }
  }
  return record;
}

function nameDump(regex, age, start, max) {

  var args = {
    'regex': regex || '^d/[a-z][a-z0-9-]{0,61}[a-z0-9]$',
    'age'  : age || blockCount - lastBlockCount,
    'start': start || scraped,
    'max'  : max || batchSize
  };

  nmc.filter(args).then(function(names, err) {
    if (err) {
      console.log(err);
    } else if (names) {
      var batch = [];
      while (names.length > 0) {
        var record = names.pop();

        if (record && record.value !== "") {
          record = cleanRecord(record);
          batch.push({'_id': record.name, 'value': record.value});
        }

      }
      db.save(batch, function(err, response) {
        if (DEBUG && err) {
          console.log(err);
        } else {
//          console.log(res);
          scraped = scraped + batchSize;
          var temp = Date.now();
          console.log(scraped + " " + Math.round(((temp - time) / 1000)));
          time = temp;

          fixBatchConflicts(response);

          if (namesTotal > scraped) {
            nameDump();
          } else {
            console.log("finished.");
            lockFile.unlock('some-file.lock', function (er) {
              console.log(er);
            });
          }
        }
      });
    }

  });
}


function fixBatchConflicts(records) {

  if (records.length > 0) {
    var record = records.pop();
    if (Object.has(record, 'error') && record.error === 'conflict') {
      update(record.id).then(function() {
        fixBatchConflicts(records);
      });
    } else {
      fixBatchConflicts(records);
    }
  }

}

function update(name) {
  return new Promise(function(resolve, reject) {
    nmc.show(name).then(function(nmcRecord) {
      nmcRecord = scrubRecord(nmcRecord);

      if (nmcRecord) {
        db.get(name, function(err, doc) {
          if (err) {
              db.save(name, nmcRecord.value); //add resolve/reject
          } else if (typeof doc !== 'undefined') {

            var cleanDoc = scrubRecord({name: name, value: doc.json});

            var keys = nmcRecord.value.keys();
            var same = true;
            keys.forEach(function(key) {
              if (!key.startsWith('_') && !key.startsWith('$')) {
                if (!Object.equal(cleanDoc[key], nmcRecord[key])) {
                  same = false;
                }
              }
            });


            if (same) {
              if (DEBUG) {
                console.log(name + " is already up to date");
              }
              resolve(true);


            } else {
              db.save(name, doc._rev, nmcRecord.value, function(error, response) {
                if (error) {
                  console.log(name + " failed to update",
                    JSON.stringify(error));
                  reject(error);
                } else {
                  console.log(name + " updated");
                  resolve(response);
                }
              });
            }

          }
          else {
            if (DEBUG) {
              console.log("no error but not updated: "
                + JSON.stringify(doc));
            }

            reject(doc);
          }
        });
      }

    });

  });
}