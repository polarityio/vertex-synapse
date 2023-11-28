'use strict';

const _ = require('lodash');

const { setLogger, getLogger } = require('./src/logger');
const { polarityRequest } = require('./src/polarity-request');
const { parseErrorToReadableJSON } = require('./src/errors');
const { PolarityResult } = require('./src/create-result-object');

function startup(logger) {
  setLogger(logger);
  const Logger = getLogger();
  Logger.trace('Startup.........');
}

async function doLookup(entities, options, cb) {
  const Logger = getLogger();

  Logger.trace({ entities, options }, 'doLookup');

  polarityRequest.setOptions(options);

  polarityRequest.setHeaders('Content-Type', 'application/json');
  polarityRequest.setHeaders('Accept', 'application/json');

  try {
    const authResponse = await polarityRequest.send({
      method: 'POST',
      url: `${options.url}/api/v1/optic/login`,
      body: {
        user: options.username,
        passwd: options.password
      }
    });

    // need to manage this session cookie
    polarityRequest.setHeaders('Cookie', authResponse[0].result.headers['set-cookie']);

    const searchResponse = await Promise.all(
      _.map(entities, (entity) => {
        return polarityRequest.send({
          entity,
          method: 'GET',
          url: `${options.url}/api/v1/storm`,
          body: {
            query: `inet:${convertTypes(entity.type)} = ${entity.value}`,
            stream: 'jsonlines',
            opts: { limit: 10 }
          }
        });
      })
    );

    // Logger.trace({ searchResponse }, 'Search Response');

    const data = processApiResponse(searchResponse);

    // Logger.trace({ data }, 'FFF');

    const polarityResult = new PolarityResult();

    const lookupResults = data.map((result) => {
      const preprocessedData = buildResultObject(result);
      return polarityResult.createResultsObject(preprocessedData);
    });

    Logger.trace({ lookupResults }, 'Lookup Results');

    return cb(null, lookupResults);
  } catch (err) {
    Logger.error({ err }, 'Error in doLookup');
    const error = parseErrorToReadableJSON(err);
    return cb(error);
  }
}

// this fuction is to make it easier to render the data in the template, as the properties
// from the API response can be difficult to access.
function buildResultObject(result) {
  const newDetails = {
    ...result.props,
    entity: result.entity,
    created: result.props['.created'],
    seen: result.props['.seen'],
    dns_rev: result.props['dns:rev'],
    nodeCount: result.nodeCount
  };

  return newDetails;
}

function processApiResponse(nestedResponsesArray) {
  const Logger = getLogger();
  let allPropsData = [];

  nestedResponsesArray.forEach((responseArray) => {
    let count = 0; // Reset count for each responseArray

    responseArray.forEach((response) => {
      if (response && response.result) {
        Logger.trace({ response }, 'Response');
        const jsonStrings = response.result.body.trim().split('\n');

        Logger.trace({ jsonStrings }, 'JSON Strings');

        const propsData = jsonStrings
          .map((jsonString) => {
            try {
              const parsedObject = JSON.parse(jsonString);

              if (
                Array.isArray(parsedObject) &&
                parsedObject[0] === 'node' &&
                Array.isArray(parsedObject[1])
              ) {
                const nodeData = parsedObject[1]; // if there is no node data, we don't want to return anything.

                if (nodeData.length >= 2 && nodeData[1].hasOwnProperty('props')) {
                  count += 1; // Increment count for each node

                  return {
                    props: nodeData[1].props,
                    entity: response.entity,
                    nodeCount: count
                  };
                }
              }
            } catch (error) {
              Logger.error({ error }, 'Error Parsing JSON');
            }
            return undefined;
          })
          .filter(Boolean);

        allPropsData = allPropsData.concat(propsData);
      } else {
        Logger.error('Response or response.result.body is not in the expected format.');
      }
    });
  });

  return allPropsData;
}

function validateOptions(userOptions, cb) {
  const requiredFields = [
    { key: 'url', message: 'You must provide a valid URL' },
    { key: 'username', message: 'You must provide a valid ScoutPrime API Key' },
    { key: 'password', message: 'You must provide a valid ScoutPrime API Key' }
  ];

  const errors = requiredFields.reduce((acc, { key, message }) => {
    if (
      typeof userOptions[key].value !== 'string' ||
      userOptions[key].value.length === 0
    ) {
      acc.push({ key, message });
    }
    return acc;
  }, []);

  return cb(null, errors);
}

function convertTypes(type) {
  switch (type) {
    case 'IPv4':
      return 'ipv4';
    case 'IPv6':
      return 'ipv6';
    case 'domain':
      return 'fqdn';
    case 'email':
      return 'email';
    default:
      return type;
  }
}
module.exports = {
  doLookup,
  validateOptions,
  startup
};
