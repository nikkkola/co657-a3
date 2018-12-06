// const request = require('request');
const request = require('request-promise');
const mqtt = require('mqtt');
const express = require('express');
const app = express();
const API_PORT = 8080;
const router = express.Router();
const sensor_f3 = "lairdc0ee4000010109f3"; //The sensor with id 'lairdc0ee4000010109f3'
const distance_sensor_from_river_bed_sensor_f3 = 1820;
const distance_flood_plain_from_river_bed_sensor_f3 = 1820;
const sensor_45 = "lairdc0ee400001012345"; //The sensor with id 'lairdc0ee400001012345'
const distance_sensor_from_river_bed_sensor_45 = 1340;
const distance_flood_plain_from_river_bed_sensor_45 = 1200;

var queryHandler = require('./queryHandler');
var geoLib = require('geo-lib'); //A library which helps with coordinates calculations

var options = require('./options'); //The parsed options file
var host = options.storageConfig.mqtt_host;
var port = options.storageConfig.port;
var appID = options.storageConfig.appID;
var accessKey = options.storageConfig.accessKey;

var mqtt_options = {
  port: port,
  username: appID,
  password: accessKey
};

const client = mqtt.connect(host, mqtt_options);

var hexPayload; //distance to water (hex)
var distance; //distance to water in mm
var floodAlert = false;

// receive data and add it to a database
client.on('connect', () => {
  console.log("Connected");
  client.subscribe('kentwatersensors/devices/+/up', () => {
    client.on('message', (topic, message, packet) => {
      var payload = JSON.parse(message);
      console.log("Received message from " + payload.dev_id);
      hexPayload = Buffer.from(payload.payload_raw, 'base64').toString('hex'); //the distance in hex format
      distance = parseInt(hexPayload, 16); //the integer value (distance in mm)

      var distance_sensor_from_river_bed;
      var distance_flood_plain_from_river_bed;

      switch (payload.devID) {
        case sensor_45:
          distance_sensor_from_river_bed = distance_sensor_from_river_bed_sensor_45;
          distance_flood_plain_from_river_bed = distance_flood_plain_from_river_bed_sensor_45;
          break;
        case sensor_f3:
          distance_sensor_from_river_bed = distance_sensor_from_river_bed_sensor_f3;
          distance_flood_plain_from_river_bed = distance_flood_plain_from_river_bed_sensor_f3;
          break;
      }

      //TODO handle the 300mm difference
      if (distance <= distance_sensor_from_river_bed - distance_flood_plain_from_river_bed) {
        console.log('SHIIT FLOOD GET THE BOAT');
        floodAlert = true;
      } else {
        console.log('NO flood');
      }

      var params = {
        timestamp: payload.metadata.time,
        dev_id: payload.dev_id,
        distanceToSensor: distance
      };

      queryHandler.insertLogRecord(params);
      floodAlert = false;
    });
  });
});

function getLatestData(stationReference) {
  return request('https://environment.data.gov.uk/flood-monitoring/id/stations/' + stationReference + '/measures', {
      json: true
    })
    .then(function(data) {
      return data.items[0].latestReading.value;
    }).catch((err) => setImmediate(() => {
      throw err;
    }));
}

/**
 * Returns the closest n (noOfResults) stations of a given type (sensorType
 * ("level" for water level stations
 *  "rainfall" for rainfall stations))
 * within a given radius (in km) of a given point on a map's coordinates (latitude,longitude)
 * NB: the 'request' package supports HTTPS and follows redirects by default :-)
 *
 * @param  {long} latitude      Geographical latitude
 * @param  {long} longitude     Geographical longitude
 * @param  {int} radius         The radius to look for sensors in
 * @param  {String} sensorType  The type of the sensor - level /rainfall)
 * @param  {int} noOfResults    The requested number of closest stations
 * @return {array}              The closest n stations
 */
function getNearestGovStations(latitude, longitude, radius, sensorType, noOfResults) {
  return request('https://environment.data.gov.uk/flood-monitoring/id/stations/?lat=' + latitude + '&long=' + longitude + '&dist=' + radius, {
      json: true
    })
    .then(function(data) {
      var sensors = data.items;
      var locationsMap = {};
      for (var i = 0; i < sensors.length; i++) {
        if (sensors[i].measures[0].parameter == sensorType) {
          locationsMap[sensors[i].notation] = locationsMap[sensors[i].notation] || [];
          locationsMap[sensors[i].notation].push(sensors[i].lat, sensors[i].long);
        }
      }

      var distancesMap = {};
      Object.keys(locationsMap).forEach(function(key) {
        var result = geoLib.distance([
          [latitude, longitude],
          [locationsMap[key][0], locationsMap[key][1]]
        ]);
        distancesMap[key] = distancesMap[key] || [];
        distancesMap[key].push(result.distance);
      });
      var sortedDistances = [];
      for (var distance in distancesMap) {
        sortedDistances.push([distance, distancesMap[distance]]);
      }
      sortedDistances.sort(function(a, b) {
        return a[1] - b[1];
      });
      var stations = [];
      for (var i = 0; i < sortedDistances.length; i++) {
        stations.push(sortedDistances[i][0]);
      }
      return stations.slice(0, noOfResults);

    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
}
//NOTE EXAMPLE:
getNearestGovStations('51.280233', '1.0789089', 5, 'level', 2)
  .then(result => {
    console.log(result);
    var promises = [];
    result.map(stationReference => {
      promises.push(getLatestData(stationReference));
    });
    Promise.all(promises).then(data => {
      console.log(data);
    })
  }).catch((err) => setImmediate(() => {
    throw err;
  }));

getLatestData('E3826').then(result => {
  console.log(result);
  return result;
}).catch((err) => setImmediate(() => {
  throw err;
}));

//TODO write a function which gets the latest data from a given gov sensor

//get the latest reading for a given sensor
queryHandler.getLatestReading(sensor_f3).then(function(rows) {
  console.log("Latest reading is " +
    rows[0].distanceToSensor + " from " + rows[0].timestamp);
}).catch((err) => setImmediate(() => {
  throw err;
})); // Throw async to escape the promise chain


getNearestGovStations('51.280233', '1.0789089', 5, 'level', 2);

function getPolygonData(urls) {
  let polygonCoordinates = [];
  // map all urls to async requests
  var promises = urls.map(url => request(url, {
    json: true
  }));
  // return an array of promises
  return Promise.all(promises)
    .then((data) => {
      return data;
    });
}

// this is our get method
// this method fetches all available data in our database
router.get("/getData/:deviceId/:startDate?/:endDate?", (req, res) => {
  // if start and end date have not been passed as parameters
  // then we need to return the latest reading
  let funCall = ((!req.params.startDate || !req.params.endDate) ?
    queryHandler.getLatestReading(req.params.deviceId) :
    queryHandler.getDataForPeriod(req.params.deviceId, req.params.startDate, req.params.endDate));
  funCall.then(function(rows) {
      res.json(rows);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

// this returns all flood areas polygon coordinates from the EA API
router.get("/getFloodAreas", (req, res) => {
  var areasURLs = []; // array to put all polygon coordinates in
  var items = []; // array to keep the item objects in as we need to return them too

  // call appropriate url depending on whether query parameter has been passed
  let url = (req.query.current ?
    'https://environment.data.gov.uk/flood-monitoring/id/floods' :
    'https://environment.data.gov.uk/flood-monitoring/id/floodAreas?lat=51.2802&long=1.0789&dist=5');

  request(url, { json: true })
    .then(function(body) {
      items = body.items;
      // extract polygon objects from response
      body.items.forEach(area => {
        if(req.query.current) {
          areasURLs.push(area.floodArea.polygon);
        }
        else {
          areasURLs.push(area.polygon);
        }
      })
      // this returns a promise for the next then callback
      return getPolygonData(areasURLs);
    })
    .then(data => {
      // return an array of multipolygon coordinates
      res.json([items, data]);
    })
    .catch((err) => setImmediate(() => {
      throw err;
    }));
});

// append /api for our http requests
app.use("/api", router);

// launch our backend into a port
app.listen(API_PORT, () => console.log(`LISTENING ON PORT ${API_PORT}`));
