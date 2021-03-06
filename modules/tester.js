/*!
 * Casper is a navigation utility for PhantomJS.
 *
 * Documentation: http://casperjs.org/
 * Repository:    http://github.com/n1k0/casperjs
 *
 * Copyright (c) 2011-2012 Nicolas Perriault
 *
 * Part of source code is Copyright Joyent, Inc. and other Node contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

/*global CasperError exports phantom require*/

var fs = require('fs');
var events = require('events');
var utils = require('utils');
var f = utils.format;

exports.create = function create(casper, options) {
    "use strict";
    return new Tester(casper, options);
};

/**
 * Casper tester: makes assertions, stores test results and display then.
 *
 * @param  Casper       casper   A valid Casper instance
 * @param  Object|null  options  Options object
 */
var Tester = function Tester(casper, options) {
    "use strict";

    if (!utils.isCasperObject(casper)) {
        throw new CasperError("Tester needs a Casper instance");
    }

    this.currentTestFile = null;
    this.exporter = require('xunit').create();
    this.includes = [];
    this.running = false;
    this.suites = [];
    this.options = utils.mergeObjects({
        failText: "FAIL", // text to use for a successful test
        passText: "PASS", // text to use for a failed test
        pad:      80      // maximum number of chars for a result line
    }, options);

    // properties
    this.testResults = {
        passed: 0,
        failed: 0,
        passes: [],
        failures: []
    };

    // events
    casper.on('error', function(msg, backtrace) {
        var line = 0;
        try {
            line = backtrace[0].line;
        } catch (e) {}
        this.test.uncaughtError(msg, this.test.currentTestFile, line);
        this.test.done();
    });

    casper.on('step.error', function onStepError(e) {
        this.test.uncaughtError(e, this.test.currentTestFile);
        this.test.done();
    });

    this.on('success', function onSuccess(success) {
        this.testResults.passes.push(success);
        this.exporter.addSuccess(fs.absolute(success.file), success.message || success.standard);
    });

    this.on('fail', function onFail(failure) {
        // export
        this.exporter.addFailure(
            fs.absolute(failure.file),
            failure.message  || failure.standard,
            failure.standard || "test failed",
            failure.type     || "unknown"
        );
        this.testResults.failures.push(failure);
        // special printing
        if (failure.type) {
            this.comment('   type: ' + failure.type);
        }
        if (failure.values && Object.keys(failure.values).length > 0) {
            for (var name in failure.values) {
                var comment = '   ' + name + ': ';
                var value = failure.values[name];
                try {
                    comment += utils.serialize(failure.values[name]);
                } catch (e) {
                    try {
                        comment += utils.serialize(failure.values[name].toString());
                    } catch (e) {
                        comment += '(unserializable value)';
                    }
                }
                this.comment(comment);
            }
        }
    });

    // methods
    /**
     * Asserts that a condition strictly resolves to true. Also returns an
     * "assertion object" containing useful informations about the test case
     * results.
     *
     * This method is also used as the base one used for all other `assert*`
     * family methods; supplementary informations are then passed using the
     * `context` argument.
     *
     * @param  Boolean      subject  The condition to test
     * @param  String       message  Test description
     * @param  Object|null  context  Assertion context object (Optional)
     * @return Object                An assertion result object
     */
    this.assert = this.assertTrue = function assert(subject, message, context) {
        return this.processAssertionResult(utils.mergeObjects({
            success:  subject === true,
            type:     "assert",
            standard: "Subject is strictly true",
            message:  message,
            file:     this.currentTestFile,
            values:  {
                subject: utils.getPropertyPath(context, 'values.subject') || subject
            }
        }, context || {}));
    };

    /**
     * Asserts that two values are strictly equals.
     *
     * @param  Mixed   subject   The value to test
     * @param  Mixed   expected  The expected value
     * @param  String  message   Test description (Optional)
     * @return Object            An assertion result object
     */
    this.assertEquals = this.assertEqual = function assertEquals(subject, expected, message) {
        return this.assert(this.testEquals(subject, expected), message, {
            type:     "assertEquals",
            standard: "Subject equals the expected value",
            values:  {
                subject:  subject,
                expected: expected
            }
        });
    };

    /**
     * Asserts that two values are strictly not equals.
     *
     * @param  Mixed        subject   The value to test
     * @param  Mixed        expected  The unwanted value
     * @param  String|null  message   Test description (Optional)
     * @return Object                 An assertion result object
     */
    this.assertNotEquals = function assertNotEquals(subject, shouldnt, message) {
        return this.assert(!this.testEquals(subject, shouldnt), message, {
            type:    "assertNotEquals",
            standard: "Subject doesn't equal what it shouldn't be",
            values:  {
                subject:  subject,
                shouldnt: shouldnt
            }
        });
    };

    /**
     * Asserts that a code evaluation in remote DOM resolves to true.
     *
     * @param  Function  fn       A function to be evaluated in remote DOM
     * @param  String    message  Test description
     * @param  Object    params   Object containing the parameters to inject into the function (optional)
     * @return Object             An assertion result object
     */
    this.assertEval = this.assertEvaluate = function assertEval(fn, message, params) {
        return this.assert(casper.evaluate(fn, params), message, {
            type:    "assertEval",
            standard: "Evaluated function returns true",
            values: {
                fn: fn,
                params: params
            }
        });
    };

    /**
     * Asserts that the result of a code evaluation in remote DOM equals
     * an expected value.
     *
     * @param  Function     fn        The function to be evaluated in remote DOM
     * @param  Boolean      expected  The expected value
     * @param  String|null  message   Test description
     * @param  Object|null  params    Object containing the parameters to inject into the function (optional)
     * @return Object                 An assertion result object
     */
    this.assertEvalEquals = this.assertEvalEqual = function assertEvalEquals(fn, expected, message, params) {
        var subject = casper.evaluate(fn, params);
        return this.assert(this.testEquals(subject, expected), message, {
            type:    "assertEvalEquals",
            standard: "Evaluated function returns the expected value",
            values:  {
                fn: fn,
                params: params,
                subject:  subject,
                expected: expected
            }
        });
    };

    /**
     * Asserts that an element matching the provided selector expression exists in
     * remote DOM.
     *
     * @param  String   selector  Selector expression
     * @param  String   message   Test description
     * @return Object             An assertion result object
     */
    this.assertExists = this.assertExist = this.assertSelectorExists = this.assertSelectorExist = function assertExists(selector, message) {
        return this.assert(casper.exists(selector), message, {
            type: "assertExists",
            standard: f("Found an element matching %s", this.colorize(selector, 'COMMENT')),
            values: {
                selector: selector
            }
        });
    };

    /**
     * Asserts that an element matching the provided selector expression does not
     * exists in remote DOM.
     *
     * @param  String   selector  Selector expression
     * @param  String   message   Test description
     * @return Object             An assertion result object
     */
    this.assertDoesntExist = this.assertNotExists = function assertDoesntExist(selector, message) {
        return this.assert(!casper.exists(selector), message, {
            type: "assertDoesntExist",
            standard: f("No element matching selector %s is found", this.colorize(selector, 'COMMENT')),
            values: {
                selector: selector
            }
        });
    };

    /**
     * Asserts that current HTTP status is the one passed as argument.
     *
     * @param  Number  status   HTTP status code
     * @param  String  message  Test description
     * @return Object           An assertion result object
     */
    this.assertHttpStatus = function assertHttpStatus(status, message) {
        var currentHTTPStatus = casper.currentHTTPStatus;
        return this.assert(this.testEquals(casper.currentHTTPStatus, status), message, {
            type: "assertHttpStatus",
            standard: f("HTTP status code is %s", this.colorize(status, 'COMMENT')),
            values: {
                current: currentHTTPStatus,
                expected: status
            }
        });
    };

    /**
     * Asserts that a provided string matches a provided RegExp pattern.
     *
     * @param  String   subject  The string to test
     * @param  RegExp   pattern  A RegExp object instance
     * @param  String   message  Test description
     * @return Object            An assertion result object
     */
    this.assertMatch = this.assertMatches = function assertMatch(subject, pattern, message) {
        return this.assert(pattern.test(subject), message, {
            type: "assertMatch",
            standard: "Subject matches the provided pattern",
            values:  {
                subject: subject,
                pattern: pattern.toString()
            }
        });
    };

    /**
     * Asserts a condition resolves to false.
     *
     * @param  Boolean  condition  The condition to test
     * @param  String   message    Test description
     * @return Object              An assertion result object
     */
    this.assertNot = function assertNot(condition, message) {
        return this.assert(!condition, message, {
            type: "assertNot",
            standard: "Subject is falsy",
            values: {
                condition: condition
            }
        });
    };

    /**
     * Asserts that the provided function called with the given parameters
     * will raise an exception.
     *
     * @param  Function  fn       The function to test
     * @param  Array     args     The arguments to pass to the function
     * @param  String    message  Test description
     * @return Object             An assertion result object
     */
    this.assertRaises = this.assertRaise = this.assertThrows = function assertRaises(fn, args, message) {
        var context = {
            type: "assertRaises",
            standard: "Function raises an error"
        };
        try {
            fn.apply(null, args);
            this.assert(false, message, context);
        } catch (error) {
            this.assert(true, message, utils.mergeObjects(context, {
                values: {
                    error: error
                }
            }));
        }
    };

    /**
     * Asserts that the current page has a resource that matches the provided test
     *
     * @param  Function/String  test     A test function that is called with every response
     * @param  String           message  Test description
     * @return Object                    An assertion result object
     */
    this.assertResourceExists = this.assertResourceExist = function assertResourceExists(test, message) {
        return this.assert(casper.resourceExists(test), message, {
            type: "assertResourceExists",
            standard: "Expected resource has been found",
            values: {
                test: test
            }
        });
    };

    /**
     * Asserts that given text exits in the document body.
     *
     * @param  String  text     Text to be found
     * @param  String  message  Test description
     * @return Object           An assertion result object
     */
    this.assertTextExists = this.assertTextExist = function assertTextExists(text, message) {
        var textFound = (casper.evaluate(function _evaluate() {
            return document.body.textContent || document.body.innerText;
        }).indexOf(text) !== -1);
        return this.assert(textFound, message, {
            type: "assertTextExists",
            standard: "Found expected text within the document body",
            values: {
                text: text
            }
        });
    };

    /**
     * Asserts that title of the remote page equals to the expected one.
     *
     * @param  String  expected  The expected title string
     * @param  String  message   Test description
     * @return Object            An assertion result object
     */
    this.assertTitle = function assertTitle(expected, message) {
        var currentTitle = casper.getTitle();
        return this.assert(this.testEquals(currentTitle, expected), message, {
            type: "assertTitle",
            standard: f('Page title is "%s"', this.colorize(expected, 'COMMENT')),
            values: {
                subject: currentTitle,
                expected: expected
            }
        });
    };

    /**
     * Asserts that title of the remote page matched the provided pattern.
     *
     * @param  RegExp  pattern  The pattern to test the title against
     * @param  String  message  Test description
     * @return Object           An assertion result object
     */
    this.assertTitleMatch = this.assertTitleMatches = function assertTitleMatch(pattern, message) {
        var currentTitle = casper.getTitle();
        return this.assert(pattern.test(currentTitle), message, {
            type: "assertTitle",
            details: "Page title does not match the provided pattern",
            values: {
                subject: currentTitle,
                pattern: pattern.toString()
            }
        });
    };

    /**
     * Asserts that the provided subject is of the given type.
     *
     * @param  mixed   subject  The value to test
     * @param  String  type     The javascript type name
     * @param  String  message  Test description
     * @return Object           An assertion result object
     */
    this.assertType = function assertType(subject, type, message) {
        var actual = utils.betterTypeOf(subject);
        return this.assert(this.testEquals(actual, type), message, {
            type: "assertType",
            standard: f('Subject type is "%s"', this.colorize(type, 'COMMENT')),
            values: {
                subject: subject,
                type: type,
                actual: actual
            }
        });
    };

    /**
     * Asserts that a the current page url matches the provided RegExp
     * pattern.
     *
     * @param  RegExp   pattern    A RegExp object instance
     * @param  String   message    Test description
     * @return Object              An assertion result object
     */
    this.assertUrlMatch = this.assertUrlMatches = function assertUrlMatch(pattern, message) {
        var currentUrl = casper.getCurrentUrl();
        return this.assert(pattern.test(currentUrl), message, {
            type: "assertUrlMatch",
            standard: "Current url matches the provided pattern",
            values: {
                currentUrl: currentUrl,
                pattern: pattern.toString()
            }
        });
    };

    /**
     * Prints out a colored bar onto the console.
     *
     */
    this.bar = function bar(text, style) {
        casper.echo(text, style, this.options.pad);
    };

    /**
     * Render a colorized output. Basically a proxy method for
     * Casper.Colorizer#colorize()
     */
    this.colorize = function colorize(message, style) {
        return casper.getColorizer().colorize(message, style);
    };

    /**
     * Writes a comment-style formatted message to stdout.
     *
     * @param  String  message
     */
    this.comment = function comment(message) {
        casper.echo('# ' + message, 'COMMENT');
    };

    /**
     * Declares the current test suite done.
     *
     */
    this.done = function done() {
        this.emit('test.done');
        this.running = false;
    };

    /**
     * Writes an error-style formatted message to stdout.
     *
     * @param  String  message
     */
    this.error = function error(message) {
        casper.echo(message, 'ERROR');
    };

    /**
     * Executes a file, wraping and evaluating its code in an isolated
     * environment where only the current `casper` instance is passed.
     *
     * @param  String  file  Absolute path to some js/coffee file
     */
    this.exec = function exec(file) {
        file = this.filter('exec.file', file) || file;
        if (!fs.isFile(file) || !utils.isJsFile(file)) {
            var e = new CasperError(f("Cannot exec %s: can only exec() files with .js or .coffee extensions", file));
            e.fileName = file;
            throw e;
        }
        this.currentTestFile = file;
        phantom.injectJs(file);
    };

    /**
     * Adds a failed test entry to the stack.
     *
     * @param  String  message
     */
    this.fail = function fail(message) {
        return this.assert(false, message, {
            type:    "fail",
            standard: "explicit call to fail()"
        });
    };

    /**
     * Recursively finds all test files contained in a given directory.
     *
     * @param  String  dir  Path to some directory to scan
     */
    this.findTestFiles = function findTestFiles(dir) {
        var self = this;
        if (!fs.isDirectory(dir)) {
            return [];
        }
        var entries = fs.list(dir).filter(function _filter(entry) {
            return entry !== '.' && entry !== '..';
        }).map(function _map(entry) {
            return fs.absolute(fs.pathJoin(dir, entry));
        });
        entries.forEach(function _forEach(entry) {
            if (fs.isDirectory(entry)) {
                entries = entries.concat(self.findTestFiles(entry));
            }
        });
        return entries.filter(function _filter(entry) {
            return utils.isJsFile(fs.absolute(fs.pathJoin(dir, entry)));
        }).sort();
    };

    /**
     * Formats a message to highlight some parts of it.
     *
     * @param  String  message
     * @param  String  style
     */
    this.formatMessage = function formatMessage(message, style) {
        var parts = /^([a-z0-9_\.]+\(\))(.*)/i.exec(message);
        if (!parts) {
            return message;
        }
        return this.colorize(parts[1], 'PARAMETER') + this.colorize(parts[2], style);
    };

    /**
     * Retrieves current failure data and all failed cases.
     *
     * @return Object casedata An object containg information about cases
     * @return Number casedata.length The number of failed cases
     * @return Array  casedata.cases An array of all the failed case objects
     */
    this.getFailures = function getFailures() {
        return {
            length: this.testResults.failed,
            cases: this.testResults.failures
        };
    };

    /**
     * Retrieves current passed data and all passed cases.
     *
     * @return Object casedata An object containg information about cases
     * @return Number casedata.length The number of passed cases
     * @return Array  casedata.cases An array of all the passed case objects
     */
    this.getPasses = function getPasses() {
        return {
            length: this.testResults.passed,
            cases: this.testResults.passes
        };
    };

    /**
     * Writes an info-style formatted message to stdout.
     *
     * @param  String  message
     */
    this.info = function info(message) {
        casper.echo(message, 'PARAMETER');
    };

    /**
     * Adds a successful test entry to the stack.
     *
     * @param  String  message
     */
    this.pass = function pass(message) {
        return this.assert(true, message, {
            type:    "pass",
            standard: "explicit call to pass()"
        });
    };

    /**
     * Processes an assertion result by emitting the appropriate event and
     * printing result onto the console.
     *
     * @param  Object  result  An assertion result object
     * @return Object  The passed assertion result Object
     */
    this.processAssertionResult = function processAssertionResult(result) {
        var eventName, style, status;
        if (result.success === true) {
            eventName = 'success';
            style = 'INFO';
            status = this.options.passText;
            this.testResults.passed++;
        } else {
            eventName = 'fail';
            style = 'RED_BAR';
            status = this.options.failText;
            this.testResults.failed++;
        }
        var message = result.message || result.standard;
        casper.echo([this.colorize(status, style), this.formatMessage(message)].join(' '));
        this.emit(eventName, result);
        return result;
    };

    /**
     * Renders a detailed report for each failed test.
     *
     * @param  Array  failures
     */
    this.renderFailureDetails = function renderFailureDetails(failures) {
        if (failures.length === 0) {
            return;
        }
        casper.echo(f("\nDetails for the %d failed test%s:\n", failures.length, failures.length > 1 ? "s" : ""), "PARAMETER");
        failures.forEach(function _forEach(failure) {
            var type, message, line;
            type = failure.type || "unknown";
            line = ~~failure.line;
            message = failure.message;
            casper.echo(f('In %s:%s', failure.file, line));
            casper.echo(f('   %s: %s', type, message || failure.standard || "(no message was entered)"), "COMMENT");
        });
    };

    /**
     * Render tests results, an optionally exit phantomjs.
     *
     * @param  Boolean  exit
     */
    this.renderResults = function renderResults(exit, status, save) {
        save = utils.isString(save) ? save : this.options.save;
        var total = this.testResults.passed + this.testResults.failed, statusText, style, result;
        var exitStatus = ~~(status || (this.testResults.failed > 0 ? 1 : 0));
        if (total === 0) {
            statusText = this.options.failText;
            style = 'RED_BAR';
            result = f("%s Looks like you didn't run any test.", statusText);
        } else {
            if (this.testResults.failed > 0) {
                statusText = this.options.failText;
                style = 'RED_BAR';
            } else {
                statusText = this.options.passText;
                style = 'GREEN_BAR';
            }
            result = f('%s %s tests executed, %d passed, %d failed.',
                       statusText, total, this.testResults.passed, this.testResults.failed);
        }
        casper.echo(result, style, this.options.pad);
        if (this.testResults.failed > 0) {
            this.renderFailureDetails(this.testResults.failures);
        }
        if (save && utils.isFunction(require)) {
            try {
                fs.write(save, this.exporter.getXML(), 'w');
                casper.echo(f('Result log stored in %s', save), 'INFO', 80);
            } catch (e) {
                casper.echo(f('Unable to write results to %s: %s', save, e), 'ERROR', 80);
            }
        }
        if (exit === true) {
            casper.exit(exitStatus);
        }
    };

    /**
     * Runs al suites contained in the paths passed as arguments.
     *
     */
    this.runSuites = function runSuites() {
        var testFiles = [], self = this;
        if (arguments.length === 0) {
            throw new CasperError("runSuites() needs at least one path argument");
        }
        this.includes.forEach(function(include) {
            phantom.injectJs(include);
        });
        Array.prototype.forEach.call(arguments, function _forEach(path) {
            if (!fs.exists(path)) {
                self.bar(f("Path %s doesn't exist", path), "RED_BAR");
            }
            if (fs.isDirectory(path)) {
                testFiles = testFiles.concat(self.findTestFiles(path));
            } else if (fs.isFile(path)) {
                testFiles.push(path);
            }
        });
        if (testFiles.length === 0) {
            this.bar(f("No test file found in %s, aborting.", Array.prototype.slice.call(arguments)), "RED_BAR");
            casper.exit(1);
        }
        var current = 0;
        var interval = setInterval(function _check(self) {
            if (self.running) {
                return;
            }
            if (current === testFiles.length) {
                self.emit('tests.complete');
                clearInterval(interval);
            } else {
                self.runTest(testFiles[current]);
                current++;
            }
        }, 100, this);
    };

    /**
     * Runs a test file
     *
     */
    this.runTest = function runTest(testFile) {
        this.bar(f('Test file: %s', testFile), 'INFO_BAR');
        this.running = true; // this.running is set back to false with done()
        this.exec(testFile);
    };

    /**
     * Tests equality between the two passed arguments.
     *
     * @param  Mixed  v1
     * @param  Mixed  v2
     * @param  Boolean
     */
    this.testEquals = this.testEqual = function testEquals(v1, v2) {
        if (utils.betterTypeOf(v1) !== utils.betterTypeOf(v2)) {
            return false;
        }
        if (utils.isFunction(v1)) {
            return v1.toString() === v2.toString();
        }
        if (v1 instanceof Object && v2 instanceof Object) {
            if (Object.keys(v1).length !== Object.keys(v2).length) {
                return false;
            }
            for (var k in v1) {
                if (!this.testEquals(v1[k], v2[k])) {
                    return false;
                }
            }
            return true;
        }
        return v1 === v2;
    };

    /**
     * Processes an error caught while running tests contained in a given test
     * file.
     *
     * @param  Error|String  error      The error
     * @param  String        file       Test file where the error occurred
     * @param  Number        line       Line number (optional)
     */
    this.uncaughtError = function uncaughtError(error, file, line) {
        return this.processAssertionResult({
            success: false,
            type: "uncaughtError",
            file: file,
            line: ~~line || "unknown",
            message: utils.isObject(error) ? error.message : error,
            values: {
                error: error
            }
        });
    };
};

// Tester class is an EventEmitter
utils.inherits(Tester, events.EventEmitter);

exports.Tester = Tester;
