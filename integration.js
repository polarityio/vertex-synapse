'use strict';

const _ = require('lodash');

const { setLogger, getLogger } = require('./src/logger');
const { polarityRequest } = require('./src/polarity-request');
const { parseErrorToReadableJSON, AuthRequestError } = require('./src/errors');
const { PolarityResult } = require('./src/create-result-object');

function startup(logger) {
  setLogger(logger);
}

async function doLookup(entities, options, cb) {
  const Logger = getLogger();

  Logger.trace({ entities, options }, 'doLookup');

  polarityRequest.setOptions(options);

  polarityRequest.setHeaders('Content-Type', 'application/json');
  polarityRequest.setHeaders('Accept', 'application/json');

  try {
    await authenticateAndSetHeaders(options);
    let searchResponse = await sendRequests(entities, options);

    // Check each response for a 401 status code
    const hasAuthError = searchResponse.some(
      (response) => _.get(response, '[0].result.statusCode') === 401
    );

    if (hasAuthError) {
      Logger.trace('Reauthenticating...');
      await authenticateAndSetHeaders(options); // Reattempt authentication
      searchResponse = await sendRequests(entities, options); // Retry the requests
    }

    const data = processApiResponse(searchResponse);

    const polarityResult = new PolarityResult();

    const lookupResults = data.map((result) => {
      const preprocessedData = buildResultObject(result);
      return polarityResult.createResultsObject(preprocessedData);
    });

    return cb(null, lookupResults);
  } catch (err) {
    Logger.error({ err }, 'Error in doLookup');
    return cb(parseErrorToReadableJSON(err));
  }
}

async function authenticateAndSetHeaders(options) {
  const Logger = getLogger();
  try {
    const authResponse = await auth(options);
    polarityRequest.setHeaders('Cookie', authResponse.result.headers['set-cookie']);
  } catch (err) {
    Logger.error({ err }, 'Failed to authenticate');
    throw err;
  }
}

async function sendRequests(entities, options) {
  return await Promise.all(
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
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function auth(options, retryCount = 0) {
  const Logger = getLogger();
  try {
    const authResponse = await polarityRequest.send({
      method: 'POST',
      url: `${options.url}/api/v1/optic/login`,
      body: {
        user: options.username,
        passwd: options.password
      }
    });

    return authResponse[0];
  } catch (err) {
    if (retryCount < 3) {
      Logger.trace({ err }, `${err.message} Retrying...${retryCount + 1}}`);
      await delay(1000);
      return auth(options, retryCount + 1);
    } else {
      throw new AuthRequestError(
        'Authentication Error: Unable to authenticate with Vertex. Please check your credentials and try again.'
      );
    }
  }
}

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
    let count = 0;

    responseArray.forEach((response) => {
      if (response && response.result) {
        const jsonStrings = response.result.body.trim().split('\n');

        const propsData = jsonStrings
          .map((jsonString) => {
            try {
              const parsedObject = JSON.parse(jsonString);

              if (
                Array.isArray(parsedObject) &&
                parsedObject[0] === 'node' &&
                Array.isArray(parsedObject[1])
              ) {
                const nodeData = parsedObject[1];

                if (nodeData.length >= 2 && nodeData[1].hasOwnProperty('props')) {
                  count += 1;

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
    { key: 'username', message: 'You must provide a valid Vertex API Key' },
    { key: 'password', message: 'You must provide a valid Vertex API Key' }
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
