/*
 * Copyright (c) 2013 Adobe Systems Incorporated.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $, brackets */

define(function (require, exports, module) {
    "use strict";
    
    var Inspector = brackets.getModule("LiveDevelopment/Inspector/Inspector"),
        _         = brackets.getModule("thirdparty/lodash");
        
    var LiveEditorRemoteDriver = require('text!LiveEditorRemoteDriver.js'),
        
        // namspace in the inspected page where live editor methods live
        _namespace = 'window._LD_CSS_EDITOR',
        
        // snapshot of remote model from live editor in the inspected page (live preivew)
        _model = {},
        
        // true if live editor instance was set up
        _hasEditor = false,
        
        // milliseconds interval after which to sync the remote model with the local model snapshot
        _syncFrequency = 500,
        
        // result of setInterval()
        _syncInterval,
        
        // number of attepts to reconnect after an error
        _retryCount = 5,
        
        // misc storage; used in reconnect scenario
        _cache = {};
        
    /*
        Evaluate the given expression in the context of the live preview page.
        Returns a promise. Fails the promise if the inspector is not connected.
        
        @param {String} expression JavaScript code to be evaluated
        @return {Promise}
    */    
    function _call(expression){
        var deferred = $.Deferred();
        
        if (!expression || typeof expression !== 'string'){
            throw new TypeError('Invalid input. Expected string JS expression, got: ' + expression);
        }
        
        if (Inspector.connected() !== true){
            return deferred.reject();
        }
        
        Inspector.Runtime.evaluate(expression, function(resp){
            if (!resp || resp.wasThrown){
                console.error(resp.result)
                deferred.reject(resp.result);
            }
            else{
                deferred.resolve(resp.result);
            }
        })
        
        return deferred.promise();
    }
    
    /*
        Send instructions to setup a live editor in the live preview page 
        using the selector, css property and css value in the given model.
        
        If an editor for the current model already exists, then update it.
        The model here is an instance of Model, not an object literal like _model.
        
        @param {Object/Model} model Instance of Model obj with attributes from code editor
        @return {Object/Promise}
    */
    function _setup(model){
        
        _cache.model = _cache.model || model;
        
        var attr = {
            selector: model.get('selector'),
            value:    model.get('value'),
            property: model.get('property')
        }
        
        if (_hasEditor){
            // If we are asked to re-setup the same editor, update the existing one
            if (attr.selector == _model.selector && attr.property == _model.property){
                return _update(model);
            }
        }
        
        console.log('SETUP', attr.selector, model.get('value'));
        var expr = _namespace + '.setup('+ JSON.stringify(attr) +')';
        
        return _call(expr)
            .then(_startSyncLoop)
            .then( function(){ _hasEditor = true} )
            .fail(_whenRemoteCallFailed);
    }
    
    /*
        Send instructions to update the existing live editor in 
        the live preview page with the state of the given model.
        
        The model here is an instance of Model, not an object literal like _model.
        
        @param {Object/Model} model Instance of Model obj with attributes from code editor.
        @return {Object/Promise}
        
    */
    function _update(model){
        if (!model){
            throw new TypeError('Invalid _update() input. Expected {Model} instance, got: ' + model);
        }
        
        if (_hasEditor === false){
            return _setup(model);
        }   
        
        _cache.model = model;
        
        var attr = {
            selector: model.get('selector'),
            value:    model.get('value'),
            property: model.get('property')
        }
        
        // Asking to update a different element / property? Setup a new editor
        if (attr.selector !== _model.selector || attr.property !== _model.property){
            console.warn('Updating for a different editor');

            return _remove().then( function(){ return _setup(model); } );
        }
        
        console.log('UPDATE', attr.selector, JSON.stringify(attr));
        var expr = _namespace + '.update('+ JSON.stringify(attr) +')';
        return _call(expr).fail(_whenRemoteCallFailed);
    }
    
    /*
        Send instructions to remove the live editor from the live preview page.
        
        @return {Object/Promise}
    */
    function _remove(){
        if (_hasEditor === false){
            return;
        }
        
        console.log('REMOVE');
        
        _reset();
        var expr = _namespace + '.remove()';
        return _call(expr);
    }
    
    /*
        Reset flags and clear snapshot of remote model
    */
    function _reset(){
        _stopSyncLoop();
        _hasEditor = false;
        _model = {};
    }
    
    function _startSyncLoop(){
        _syncInterval = window.setInterval(_onSyncTick, _syncFrequency);
    }
    
    function _stopSyncLoop(){
        window.clearInterval(_syncInterval);
    }
    
    function _onSyncTick(){
        console.log('SYNC');
        var expr = _namespace + '.getModel()';
        _call(expr).then(_whenGetRemoteModel).fail(_whenRemoteCallFailed);
    }
    
    function _whenGetRemoteModel(model){
        if (!model || !model.value || typeof model.value !== 'string'){
            throw new TypeError('Invalid result from remote driver .getModel(). Expected JSON string, got:' + model);
        }
        
        var data = JSON.parse(model.value),
            hasChanged = false;
            
        // sync the local model snapshot with the remote model
        for (var key in data){
            if (!_model[key] || !_.isEqual(_model[key], data[key])){
                _model[key] = data[key];
                hasChanged = true;
            }
        }
        
        // notify Brackets so it can update the code editor
        if (hasChanged){
            $(exports).triggerHandler('modelChange', _model);
        }
    }
    
    /*
        Handle failed promises for eval calls in the inspected page.
        If the error is likely because _namespace was missing, attempt to reconnect.
    */
    function _whenRemoteCallFailed(result){
        if (result && result.description && /Cannot call method/.test(result.description)){
            return _reconnect();
        }
        else{
            _cache.model = undefined;
            return _remove();
        }
    }
    
    /*
        When a user refreshes the live preview window, the injected live editor 
        and its dependecies get lost.
        
        This method attempts to re-inject them. It tries 
        a number of times before giving up. 
        
        After a successful reconnect, it sets up the editor in the last cached state.
        
        @return {Promise}
    */
    function _reconnect(){
        var deferred = $.Deferred();
                
        function onPostInit(){
            _reset();
            _setup(_cache.model);
            _retryCount = 5; 
        }
        
        if (_retryCount === 0){
            console.warn('Gave up reconnecting');
            return deferred.reject();
        }
        
        _retryCount--;
        
        return _init(_cache.dependencies).then(onPostInit);
    }
    
    /*
        Inject remote live editor driver and any specified editor providers.
        @param {?Array} providers String sources of editors to be available in the browser; optional
    */
    function _init(providers){
        var scripts = [].concat(LiveEditorRemoteDriver, providers || []);
        
        // cache dependencies for reuse when a re-init is required (ex: after a page refresh)
        _cache.dependencies = scripts;
        
        $(exports).triggerHandler('init');
        
        return _call(scripts.join(';'));
    }
    
    exports.init = _init;
    exports.setup = _setup;
    exports.update = _update;
    exports.remove = _remove;
});
