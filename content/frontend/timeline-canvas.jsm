/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");

var EXPORTED_SYMBOLS = ["CanvasManager", "NORMALIZED_EVENT_TYPE"];

const NORMALIZED_EVENT_TYPE = {
  POINT_EVENT: 0, // An instantaneous event like a mouse click.
  CONTINUOUS_EVENT_START: 1, // Start of a process like reloading of a page.
  CONTINUOUS_EVENT_MID: 2, // End of a earlier started process.
  CONTINUOUS_EVENT_END: 3, // End of a earlier started process.
  REPEATING_EVENT_START: 4, // Start of a repeating event like a timer.
  REPEATING_EVENT_MID: 5, // An entity of a repeating event which is neither
                          // start nor end.
  REPEATING_EVENT_STOP: 6, // End of a repeating event.
};

const CANVAS_POSITION = {
  START: 0, // Represents the starting of the view
  CENTER: 1, // Represents center of view.
  END: 2, // Represents end of view.
};

const COLOR_LIST = ["#1eff07", "#0012ff", "#20dbec", "#33b5ff", "#a8ff9c", "#b3f7ff",
                    "#f9b4ff", "#f770ff", "#ff0000", "#ff61fd", "#ffaf60", "#fffc04"];

/**
 * Canvas Content Handler.
 * Manages the canvas and draws anything on it when required.
 *
 * @param object aDoc
 *        reference to the document in which the canvas resides.
 */
function CanvasManager(aDoc) {
  this.doc = aDoc
  this.currentTime = this.startTime = Date.now();
  this.lastVisibleTime = null;
  this.offsetTop = 0;
  this.scrolling = false;
  this.offsetTime = 0;
  this.scrollDistance = 0;
  this.dirtyDots = [];
  this.dirtyZone = [];

  /**
   *  This will be the storage for the timestamp of events occuring ina group.
   * {
   *  "group1":
   *    {
   *      id: 1,
   *      y: 45, // Vertical location of the group.
   *      type: NORMALIZED_EVENT_TYPE.POINT_EVENT, // one of NORMALIZED_EVENT_TYPE
   *      producerId: "PageEventsProducer", // Id of the producer related to the data.
   *      active: true, // If it is a continuous event and is still not finished.
   *    },
   *  "another_group_and_so_on" : {...},
   * }
   */
  this.groupedData = {};

  this.globalTiming = [];
  this.globalGroup = [];
  this.activeGroups = [];

  // How many milli seconds per pixel.
  this.scale = 50;

  this.id = 0;
  this.waitForLineData = false;
  this.waitForDotData = false;

  this.canvasLines = aDoc.getElementById("timeline-canvas-lines");
  this.ctxL = this.canvasLines.getContext('2d');
  this.canvasDots = aDoc.getElementById("timeline-canvas-dots");
  this.ctxD = this.canvasDots.getContext('2d');
  this.canvasRuler = aDoc.getElementById("ruler-canvas");
  this.ctxR = this.canvasRuler.getContext('2d');

  // Bind
  this.render = this.render.bind(this);
  this.moveToCurrentTime = this.moveToCurrentTime.bind(this);
  this.moveToTime = this.moveToTime.bind(this);

  this.timeFrozen = false;
  this.overview = true;
  this.render();
}

CanvasManager.prototype = {
  get width()
  {
    if (this._width === undefined) {
      this._width = this.canvasLines.width;
    }
    return this._width;
  },

  set width(val)
  {
    this._width = val;
    this.canvasRuler.width = this.canvasLines.width = this.canvasDots.width = val;
  },

  get height()
  {
    if (this._height === undefined) {
      this._height = this.canvasLines.height;
    }
    return this._height;
  },

  set height(val)
  {
    this._height = val;
    this.canvasLines.height = this.canvasDots.height = val;
  },

  get paneHeight()
  {
    if (this._paneHeight === undefined) {
      this._paneHeight = this.doc.getElementById("producers-pane").scrollHeight;
    }
    return this._paneHeight;
  },

  /**
   * Gets the Y offset of the group residing in the Producers Pane.
   *
   * @param string aGroupId
   *        Id of the group to obtain the Y offset.
   * @param string producerId
   *        Id of the producer, the group belongs to.
   *
   * @return number The offset of the groupId provided, or null.
   */
  getOffsetForGroup: function CM_getOffsetForGroup(aGroupId, producerId)
  {
    let temp = false;
    if (this.doc.getElementById("producers-pane").collapsed == true) {
      this.doc.getElementById("producers-pane").collapsed = false;
      temp = true;
    }
    let producerBoxes = this.doc.getElementsByClassName("producer-box");
    for (let i = 0; i < producerBoxes.length; i++) {
      let producerBox = producerBoxes[i];
      let id = producerBox.getAttribute("producerId");
      if (id != producerId) {
        continue;
      }

      if (producerBox.getAttribute("visible") == "false") {
        if (temp) {
          this.doc.getElementById("producers-pane").collapsed = true;
        }
        return (producerBox.firstChild.boxObject.y +
                producerBox.firstChild.boxObject.height/2 - 32);
      }

      let feature = producerBox.firstChild.nextSibling.firstChild;
      while (feature) {
        if (feature.getAttribute("groupId") == aGroupId) {
          if (temp) {
            this.doc.getElementById("producers-pane").collapsed = true;
          }
          return (feature.boxObject.y + feature.boxObject.height/2 - 32);
        }
        feature = feature.nextSibling;
      }
    }
    if (temp) {
      this.doc.getElementById("producers-pane").collapsed = true;
    }
    return null;
  },

  /**
   * Updates the Y offset related to each groupId.
   */
  updateGroupOffset: function CM_updateGroupOffset()
  {
    for (groupId in this.groupedData) {
      if (this.groupedData[groupId].type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START) {
        this.groupedData[groupId].y =
          this.getOffsetForGroup(this.groupedData[groupId].name.replace(" ", "_"),
                                 this.groupedData[groupId].producerId);
      }
      else {
        this.groupedData[groupId].y =
          this.getOffsetForGroup(groupId, this.groupedData[groupId].producerId);
      }
    }
  },

  /**
   * Binary search to match for the index having time just less than the provided.
   *
   * @param number aTime
   *        The time to searach.
   */
  searchIndexForTime: function CM_searchIndexForTime(aTime)
  {
    let {length} = this.globalTiming;
    if (this.globalTiming[length - 1] < aTime) {
      return length - 1;
    }
    let left = 0, right = length - 1,mid;
    while (right - left > 1) {
      mid = Math.floor((left + right)/2);
      if (this.globalTiming[mid] > aTime) {
        right = mid;
      }
      else if (this.globalTiming[mid] < aTime) {
        left = mid;
      }
      else
        return mid;
    }
    return left;
  },

  /**
   * Gets the corresponding time for the pixels in x direction.
   *
   * @param number aXPixel
   *        Number of pixels from start of timeline view.
   */
  getTimeForXPixels: function CM_getTimeForXPixels(aXPixel)
  {
    if (this.timeFrozen) {
      return (this.frozenTime - this.offsetTime + (aXPixel - 0.8*this.width)*this.scale);
    }
    else {
      return (this.currentTime + (aXPixel - 0.8*this.width)*this.scale);
    }
  },

  /**
   * Gets the corresponding groups for the pixels in y direction.
   *
   * @param number aYPixel
   *        Number of pixels from top of timeline view.
   */
  getGroupsForYPixels: function CM_getGroupsForYPixels(aYPixel)
  {
    let matchedGroups = [];
    for (groupId in this.groupedData) {
      if (Math.abs(this.groupedData[groupId].y - this.offsetTop - aYPixel) < 7) {
        matchedGroups.push(groupId);
      }
    }
    return matchedGroups;
  },

  getGroupForTime: function CM_getGroupForTime(aGroupId, aTime)
  {
    let group = this.groupedData[aGroupId];
    if ((group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_END ||
         group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_MID ||
         group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_START) &&
        aTime >= Math.max(this.firstVisibleTime, group.timestamps[0] - 10) &&
        aTime <= (group.active? this.lastVisibleTime:
                                group.timestamps[group.timestamps.length - 1] + 10)) {
      return group.dataIds;
    }
    // Point event type
    else if (group.timestamps[0].length == null &&
             group.type == NORMALIZED_EVENT_TYPE.POINT_EVENT) {
      let results = [];
      for (let i = 0; i < group.timestamps.length; i++) {
        if (Math.abs(group.timestamps[i] - aTime) < 4*this.scale) {
          results.push(group.dataIds[i]);
        }
      }
      if (results.length > 0) {
        return results;
      }
    }
    // Repeating event type
    else if (group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_MID ||
             group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START ||
             group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_STOP) {
      let timestamps = group.timestamps;
      let results = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (aTime >= Math.max(this.firstVisibleTime, timestamps[i][0]) &&
            aTime <= Math.min(timestamps[i][timestamps[i].length - 1],
                              this.lastVisibleTime)) {
          results.push(group.dataIds[i]);
        }
      }
      if (results.length > 0) {
        return results;
      }
    }
    return null;
  },

  /**
   * Handles mouse hover at (x, y) on the timeline view.
   */
  mouseHoverAt: function CM_mouseHoverAt(X,Y)
  {
    if (this.timeFrozen) {
      let groupIds = this.getGroupsForYPixels(Y);
      if (groupIds.length == 0) {
        this.hideDetailedData();
        return null;
      }
      let time = this.getTimeForXPixels(X);
      if (groupIds.length == 1) {
        // Continuous event type
        let matchingGroupIds = this.getGroupForTime(groupIds[0], time);
        if (matchingGroupIds && matchingGroupIds.length > 0) {
          this.displayDetailedData(X);
          return matchingGroupIds;
        }
      }
      else {
        let results = [];
        for (let groupId of groupIds) {
          let matchingGroupIds = this.getGroupForTime(groupId, time);
          if (matchingGroupIds && matchingGroupIds.length > 0) {
            results.push(matchingGroupIds[0]);
          }
        }
        if (results.length > 0 ) {
          this.displayDetailedData(X);
          return results;
        }
      }
    }
    // Hide the detailed view if nothing else matches.
    this.hideDetailedData();
    return null;
  },

  insertAtCorrectPosition: function CM_insertAtCorrectPosition(aTime, aGroupId)
  {
    let {length} = this.globalTiming;
    if (this.globalTiming[length - 1] < aTime) {
      this.globalGroup.push(aGroupId);
      this.globalTiming.push(aTime);
      return;
    }
    let left = 0, right = length - 1,mid, i = null;
    while (right - left > 1) {
      mid = Math.floor((left + right)/2);
      if (this.globalTiming[mid] > aTime) {
        right = mid;
      }
      else if (this.globalTiming[mid] < aTime) {
        left = mid;
      }
      else {
        i = mid;
        break;
      }
    }
    if (i == null) {
      i = left;
    }
    this.globalGroup.splice(i,0,aGroupId);
    this.globalTiming.splice(i,0,aTime);
  },

  /**
   * Gets the message and puts it into the groupedData.
   *
   * @param object aData
   *        The normalized event data read by the GraphUI from DataStore.
   */
  pushData: function CM_pushData(aData)
  {
    let groupId = aData.groupID;

    switch (aData.type) {
      case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_START:
        this.groupedData[groupId] = {
          id: this.id,
          name: aData.name,
          y: this.getOffsetForGroup(groupId, aData.producer),
          type: NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_START,
          producerId: aData.producer,
          active: true,
          timestamps: [aData.time],
          dataIds: [aData.id],
        };
        this.activeGroups.push(groupId);
        this.id++;
        this.waitForDotData = false;
        this.waitForLineData = false;
        break;

      case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_MID:
        try {
          this.groupedData[groupId].timestamps.push(aData.time);
          this.groupedData[groupId].dataIds.push(aData.id);
          this.waitForDotData = false;
        } catch (ex) {
          // Case when restart on relaod is true and some in-flight calls mid-ed
          return null;
        }
        break;

      case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_END:
        try {
          this.groupedData[groupId].timestamps.push(aData.time);
          this.groupedData[groupId].dataIds.push(aData.id);
          this.groupedData[groupId].active = false;
          this.activeGroups.splice(this.activeGroups.indexOf(groupId), 1);
          this.waitForDotData = false;
          this.waitForLineData = false;
        } catch (ex) {
          // Case when restart on relaod is true and some in-flight calls ended
          return null;
        }
        break;

      case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START:
        if (!this.groupedData[groupId]) {
          this.groupedData[groupId] = {
            id: this.id,
            name: aData.name,
            y: this.getOffsetForGroup(aData.name.replace(" ", "_"), aData.producer),
            type: NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START,
            producerId: aData.producer,
            active: true,
            timestamps: [[aData.time]],
            dataIds: [aData.id],
          };
          this.id++;
        }
        else {
          this.groupedData[groupId].timestamps.push([aData.time]);
          this.groupedData[groupId].dataIds.push(aData.id);
        }
        this.activeGroups.push(groupId);
        this.waitForDotData = false;
        this.waitForLineData = false;
        break;

      case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_MID:
        try {
          this.groupedData[groupId].timestamps[
            this.groupedData[groupId].timestamps.length - 1
          ].push(aData.time);
          this.waitForDotData = false;
        } catch (ex) {
          // Case when restart on relaod is true and some in-flight calls mid-ed
          return null;
        }
        break;

      case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_STOP:
        try {
          this.groupedData[groupId].timestamps[
            this.groupedData[groupId].timestamps.length - 1
          ].push(aData.time);
          this.groupedData[groupId].active = false;
          this.activeGroups.splice(this.activeGroups.indexOf(groupId), 1);
          this.waitForDotData = false;
          this.waitForLineData = false;
        } catch (ex) {
          // Case when restart on relaod is true and some in-flight calls ended
          return null;
        }
        break;

      case NORMALIZED_EVENT_TYPE.POINT_EVENT:
        if (!this.groupedData[groupId]) {
          this.groupedData[groupId] = {
            id: this.id,
            y: this.getOffsetForGroup(groupId, aData.producer),
            type: NORMALIZED_EVENT_TYPE.POINT_EVENT,
            producerId: aData.producer,
            active: false,
            timestamps: [aData.time],
            dataIds: [aData.id],
          };
          this.id++;
        }
        else {
          this.groupedData[groupId].timestamps.push(aData.time);
          this.groupedData[groupId].dataIds.push(aData.id);
        }
        this.waitForDotData = false;
        break;
    }
    this.insertAtCorrectPosition(aData.time, groupId);
    return this.groupedData[groupId].id;
  },

  freezeCanvas: function CM_freezeCanvas()
  {
    this.frozenTime = this.currentTime;
    this.timeFrozen = true;
    this.overview = false;
    try {
      this.doc.getElementById("overview").removeAttribute("checked");
    } catch (ex) {}
    this.waitForDotData = false;
    this.waitForLineData = false;
  },

  unfreezeCanvas: function CM_unfreezeCanvas()
  {
    this.timeFrozen = false;
  },

  /**
   * Moves the view to current time.
   *
   * @param boolean aAnimate
   *        If true, the view will rapidly scroll towards the current time.
   *        (true by default)
   */
  moveToCurrentTime: function TV_moveToCurrentTime(aAnimate)
  {
    if (aAnimate != null && aAnimate == false) {
      this.stopScrolling();
      this.unfreezeCanvas();
      this.offsetTime = 0;
      return;
    }
    if (this.offsetTime == 0 && !this.timeFrozen) {
      this.startingoffsetTime = null;
      this.movingView = false;
    }
    else if (!this.timeFrozen &&
             ((this.offsetTime >= 0 &&
               this.offsetTime < this.startingoffsetTime/20) ||
              (this.offsetTime < 0 &&
               this.offsetTime > this.startingoffsetTime/20))) {
      this.offsetTime = 0;
      this.startingoffsetTime = null;
      this.movingView = false;
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
    else {
      if (this.startingoffsetTime == null) {
        if (this.movingView) {
          return;
        }
        this.movingView = true;
        this.offsetTime += Date.now() - this.frozenTime;
        this.frozenTime = Date.now();
        this.unfreezeCanvas();
        this.startingoffsetTime = this.offsetTime;
      }
      this.offsetTime -= this.startingoffsetTime/20;
      this.doc.defaultView.mozRequestAnimationFrame(this.moveToCurrentTime);
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
  },

  /**
   * Moves the view to the provided time.
   *
   * @param nummber aY
   *        The vertical offset to move to.
   * @param number aPosition
   *        One of CANVAS_POSITION. (default CANVAS_POSITION.CENTER)
   * @param boolean aAnimate
   *        If true, view will rapidly animate to the provided time.
   *        (true by default)
   */
  moveTopOffsetTo: function CM_moveTopOffsetTo(aY, aPosition, aAnimate)
  {
    switch(aPosition) {
      case CANVAS_POSITION.START:
        this.finalOffset = Math.max(aY, 0);
        break;

      case CANVAS_POSITION.END:
        this.finalOffset = Math.max(aY - this.height, 0);
        break;

      default:
        aPosition = CANVAS_POSITION.CENTER;
        this.finalOffset = Math.max(aY - this.height*0.5, 0);
        break;
    }
    if (aAnimate != null && aAnimate == false) {
      this.freezeCanvas();
      this.doc.getElementById("producers-pane").scrollTop = this.offsetTop = this.finalOffset;
      this.offsetTime = 0;
      return;
    }
    if (this.initialOffset == null) {
      if (!this.timeFrozen) {
        this.freezeCanvas();
      }
      this.initialOffset = this.offsetTop;
    }
    if ((this.finalOffset == this.offsetTop) ||
        (this.finalOffset - this.offsetTop >= 0 &&
         this.finalOffset - this.offsetTop <= 0.05*(this.initialOffset - this.finalOffset)) ||
        (this.finalOffset - this.offsetTop < 0 &&
         this.finalOffset - this.offsetTop >= 0.05*(this.initialOffset - this.finalOffset))) {
      this.freezeCanvas();
      this.doc.getElementById("producers-pane").scrollTop = this.finalOffset;
      this.offsetTop = this.doc.getElementById("producers-pane").scrollTop;
      this.finalOffset = this.initialOffset = null;
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
    else {
      let initial = this.doc.getElementById("producers-pane").scrollTop*1;
      this.doc.getElementById("producers-pane").scrollTop -=
        0.05*(this.initialOffset - this.finalOffset);
      if (initial == this.doc.getElementById("producers-pane").scrollTop) {
        // Destination is already reached, no need to go any further.
        aY -= (this.finalOffset - initial);
        this.offsetTop = initial;
      }
      else {
        this.offsetTop = this.doc.getElementById("producers-pane").scrollTop;
      }
      this.doc.defaultView
          .mozRequestAnimationFrame(function() {
        this.moveTopOffsetTo(aY, aPosition, true);
      }.bind(this));
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
  },

  /**
   * Moves the view to the provided time.
   *
   * @param nummber aTime
   *        The time to move to.
   * @param number aPosition
   *        One of CANVAS_POSITION. (default CANVAS_POSITION.CENTER)
   * @param boolean aAnimate
   *        If true, view will rapidly animate to the provided time.
   *        (true by default)
   */
  moveToTime: function CM_moveToTime(aTime, aPosition, aAnimate)
  {
    switch(aPosition) {
      case CANVAS_POSITION.START:
        this.finalFrozenTime = aTime + 0.8*this.width*this.scale;
        break;

      case CANVAS_POSITION.END:
        this.finalFrozenTime = aTime - 0.2*this.width*this.scale;
        break;

      default:
        aPosition = CANVAS_POSITION.CENTER;
        this.finalFrozenTime = aTime + 0.3*this.width*this.scale;
        break;
    }
    if (aAnimate != null && aAnimate == false) {
      this.freezeCanvas();
      this.frozenTime = this.finalFrozenTime;
      this.offsetTime = 0;
      return;
    }
    if (this.initialFrozenTime == null) {
      if (!this.timeFrozen) {
        this.freezeCanvas();
      }
      else {
        this.frozenTime -= this.offsetTime;
        this.offsetTime = 0;
      }
      this.initialFrozenTime = this.frozenTime;
    }
    if ((this.finalFrozenTime - this.frozenTime >= 0 &&
         this.finalFrozenTime - this.frozenTime <= 0.05*(this.initialFrozenTime - this.finalFrozenTime)) ||
        (this.finalFrozenTime - this.frozenTime < 0 &&
         this.finalFrozenTime - this.frozenTime >= 0.05*(this.initialFrozenTime - this.finalFrozenTime))) {
      this.freezeCanvas();
      this.frozenTime = this.finalFrozenTime;
      this.finalFrozenTime = this.initialFrozenTime = null;
      this.movingView = false;
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
    else {
      this.movingView = true;
      this.frozenTime -= 0.05*(this.initialFrozenTime - this.finalFrozenTime);
      this.doc.defaultView
          .mozRequestAnimationFrame(function() {
        this.moveToTime(aTime, aPosition, true);
      }.bind(this));
      this.waitForLineData = false;
      this.waitForDotData = false;
    }
  },

  /**
   * Moves the event represented by the groupId into the view.
   *
   * @param string aGroupId
   *        The group to move to.
   * @param boolean aVertical
   *        True to move vertically also.
   */
  moveGroupInView: function moveGroupInView(aGroupId, aVertical)
  {
    if (this.movingView) {
      return;
    }
    if (this.groupedData[aGroupId]) {
      let group = this.groupedData[aGroupId];
      let time = null;
      let y = group.y;
      switch (group.type) {
        case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_STOP:
        case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START:
        case NORMALIZED_EVENT_TYPE.REPEATING_EVENT_MID:
          time = group.timestamps[group.timestamps.length - 1][0];
          break;

        case NORMALIZED_EVENT_TYPE.POINT_EVENT:
          time = group.timestamps[group.timestamps.length - 1];
          break;

        case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_END:
        case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_MID:
        case NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_START:
          time = group.timestamps[0];
          break;

        default:
          return;
      }
      this.moveToTime(time);
      if (aVertical) {
        this.moveTopOffsetTo(y);
      }
    }
  },

  moveToOverview: function CM_moveToOverview()
  {
    this.unfreezeCanvas();
    this.overview = true;
    this.scale = (Date.now() - this.startTime)/(0.8*this.width);
    this.waitForDotData = false;
    this.waitForLineData = false;
  },

  moveToLive: function CM_moveToLive()
  {
    this.overview = false;
    if (!this.timeFrozen) {
      this.scale = 5;
      this.moveToCurrentTime();
    }
  },

  startRendering: function CM_startRendering()
  {
    this.ctxL.clearRect(0,0,this.width,this.height);
    this.ctxD.clearRect(0,0,this.width,this.height);
    this.ctxR.clearRect(0,0,this.width,25);
    this.groupedData = {};
    this.activeGroups = [];
    this.globalTiming = [];
    this.globalGroup = [];
    this.dirtyDots = [];
    this.dirtyZone = [];
    this.waitForDotData = this.waitForLineData = false;
    this.id = 0;
    this.stopTime = null;
    this.render();
    this.startTime = Date.now();
  },

  stopRendering: function CM_stopRendering()
  {
    this.stopTime = Date.now();
  },

  startScrolling: function CM_startScrolling()
  {
    this.scrolling = true;
    this.waitForDotData = false;
    this.waitForLineData = false;
  },

  stopScrolling: function CM_stopScrolling()
  {
    this.offsetTime = this.frozenTime - this.currentTime;
    this.scrollDistance = 0;
    this.scrolling = false;
  },

  startTimeWindowAt: function CM_startTimeWindowAt(left)
  {
    this.timeWindowLeft = this.getTimeForXPixels(left);
    this.leftWindowLine = left;
  },

  stopTimeWindowAt: function CM_stopTimeWindowAt(right)
  {
    this.timeWindowRight = this.getTimeForXPixels(right);
    if (right - this.leftWindowLine > 3 ||
        this.timeWindowRight - this.timeWindowLeft > 200) {
      this.freezeCanvas();
      this.scale = (this.timeWindowRight - this.timeWindowLeft)/this.width;
      this.offsetTime = 0;
      this.frozenTime = this.timeWindowLeft + 0.8*this.width*this.scale;
      try {
        this.doc.getElementById("overview").removeAttribute("checked");
      } catch (ex) {}
    }
    this.leftWindowLine = this.timeWindowLeft = this.timeWindowRight = null;
  },

  displayDetailedData: function CM_displayDetailedData(aLeft)
  {
    this.doc.getElementById("timeline-detailbox").setAttribute("visible", true);
    this.doc.getElementById("timeline-detailbox").style.left = (aLeft < 250 ? this.width - 260: 20) + "px";
  },

  hideDetailedData: function CM_hideDetailedData()
  {
    this.doc.getElementById("timeline-detailbox").setAttribute("visible", false);
  },

  /**
   * Draws a dot to represnt an event at the x,y.
   */
  drawDot: function CM_drawDot(x, y, id)
  {
    if (this.offsetTop > y || y - this.offsetTop > this.height ||
        x < 0 || x > this.width) {
      return;
    }
    if (this.dirtyDots.length > 0) {
      let {lastX,lastY,lastId} = this.dirtyDots[this.dirtyDots.length - 1];
      if (lastId == id && lastY == (y - this.offsetTop) && Math.abs(x - lastX) < 3) {
        return;
      }
    }
    this.ctxD.beginPath();
    this.ctxD.fillStyle = COLOR_LIST[id%12];
    this.dirtyDots.push({x:x,y:y-this.offsetTop,id:id});
    this.ctxD.arc(x,y - this.offsetTop -0.5, 3, 0, 6.2842,true);
    this.ctxD.fill();
    this.dotsDrawn++;
  },

  /**
   * Draws a horizontal line from x,y to endx,y.
   */
  drawLine: function CM_drawLine(x, y, id, endx)
  {
    if (this.offsetTop > y || y - this.offsetTop > this.height) {
      return;
    }
    this.ctxL.fillStyle = COLOR_LIST[id%12];
    this.ctxL.fillRect(x, y - 1.5 - this.offsetTop, endx-x, 2);
    this.linesDrawn++;
    this.dirtyZone[0] = Math.min(this.dirtyZone[0],x);
    this.dirtyZone[1] = Math.max(this.dirtyZone[1],endx);
    this.dirtyZone[2] = Math.min(this.dirtyZone[2],y - 2 - this.offsetTop);
    this.dirtyZone[3] = Math.max(this.dirtyZone[3],y + 2 - this.offsetTop);
  },

  /**
   * Renders the canvas ruler, lines and dots.
   */
  render: function CM_render()
  {
    // getting the current time, which will be at the center of the canvas.
    let date = (this.stopTime? this.stopTime: Date.now());
    if (this.timeFrozen) {
      if (!this.scrolling) {
        this.currentTime = this.frozenTime - this.offsetTime;
      }
      else if (this.scrollDistance != 0) {
        this.currentTime = this.frozenTime - this.offsetTime -
                           this.scrollDistance * 5 * this.scale;
      }
    }
    else if (this.overview) {
      // Check if any continuous or repeating event is currently unfinished.
      // If so, then draw full time width, else, draw to the max time of any event.
      if (this.activeGroups.length == 0 && this.globalTiming.length > 0) {
        this.currentTime = this.globalTiming[this.globalTiming.length - 1];
      }
      else {
        this.currentTime = date;
      }
      this.scale = (this.currentTime - this.startTime)/(0.8*this.width);
    }
    else {
      this.currentTime = date - this.offsetTime;
    }
    this.firstVisibleTime = this.currentTime - 0.8*this.width*this.scale;
    this.lastVisibleTime = this.firstVisibleTime + this.width*this.scale;

    this.currentWidth = Math.min(0.8*this.width + (this.scrolling? (date -
                                 this.currentTime)/this.scale:(this.timeFrozen?
                                  (date - this.frozenTime + this.offsetTime)/this.scale
                                 :(this.offsetTime + date - this.currentTime)/this.scale)),
                                 this.width);

    // Moving the current time needle to appropriate position.
    this.doc.getElementById("timeline-current-time").style.left = this.currentWidth + "px";

    // Drawing the time ruler.
    this.ctxR.clearRect(0,0,this.width,25);
    this.ctxR.fillStyle = "rgb(3,101,151)";
    this.ctxR.font = "16px sans-serif";
    this.ctxR.lineWidth = 0.5;
    if (this.scale > 50) {
      for (let i = -((this.firstVisibleTime - this.startTime)%50000 + 50000)/this.scale,
               j = 0;
           i < this.width;
           i += 5000/this.scale, j++) {
        if (j%10 == 0) {
          this.ctxR.fillText(Math.floor((this.firstVisibleTime + i*this.scale - this.startTime)/1000) + " s",
                               i + 2, 12);
          this.ctxR.fillRect(i+0.5,5,1,20);
        }
        else if (j%5 == 0) {
          this.ctxR.fillRect(i+0.5,10,1,15);
        }
        else {
          this.ctxR.fillRect(i+0.5,15,1,10);
        }
      }
    }
    else if (this.scale > 20) {
      for (let i = -((this.firstVisibleTime - this.startTime)%10000 + 10000)/this.scale,
               j = 0;
           i < this.width;
           i += 1000/this.scale, j++) {
        if (j%10 == 0) {
          this.ctxR.fillText(Math.floor((this.firstVisibleTime + i*this.scale - this.startTime)/1000) + " s",
                               i + 2, 12);
          this.ctxR.fillRect(i+0.5,5,1,20);
        }
        else if (j%5 == 0) {
          this.ctxR.fillRect(i+0.5,10,1,15);
        }
        else {
          this.ctxR.fillRect(i+0.5,15,1,10);
        }
      }
    }
    else if (this.scale > 1) {
      for (let i = -((this.firstVisibleTime - this.startTime)%1000 + 1000)/this.scale,
               j = 0;
           i < this.width;
           i += 100/this.scale, j++) {
        if (j%10 == 0) {
          this.ctxR.fillText(Math.floor((this.firstVisibleTime + i*this.scale - this.startTime)/1000) + " s",
                               i + 2, 12);
          this.ctxR.fillRect(i+0.5,5,1,20);
        }
        else if (j%5 == 0) {
          this.ctxR.fillRect(i+0.5,10,1,15);
        }
        else {
          this.ctxR.fillRect(i+0.5,15,1,10);
        }
      }
    }
    else if (this.scale > 0.1) {
      for (let i = -((this.firstVisibleTime - this.startTime)%100 + 100)/this.scale,
               j = 0;
           i < this.width;
           i += 10/this.scale, j++) {
        if (j%10 == 0) {
          this.ctxR.fillText((this.firstVisibleTime + i*this.scale - this.startTime) + " ms",
                               i + 2, 12);
          this.ctxR.fillRect(i+0.5,5,1,20);
        }
        else if (j%5 == 0) {
          this.ctxR.fillRect(i+0.5,10,1,15);
        }
        else {
          this.ctxR.fillRect(i+0.5,15,1,10);
        }
      }
    }
    else if (this.scale > 0) {
      for (let i = -((this.firstVisibleTime - this.startTime)%10 + 10)/this.scale,
               j = 0;
           i < this.width;
           i += 1/this.scale, j++) {
        if (j%10 == 0) {
          this.ctxR.fillText((this.firstVisibleTime + i*this.scale - this.startTime) + " ms",
                               i + 2, 12);
          this.ctxR.fillRect(i+0.5,5,1,20);
        }
        else if (j%5 == 0) {
          this.ctxR.fillRect(i+0.5,10,1,15);
        }
        else {
          this.ctxR.fillRect(i+0.5,15,1,10);
        }
      }
    }
    if (!this.waitForLineData) {
      this.linesDrawn = 0;

      let ([x,endx,y,endy,v] = this.dirtyZone) {
        this.ctxL.clearRect(x-1,y-1,endx-x+12,endy-y+2);
        this.ctxL.clearRect(v - 10,0,20,this.height);
        this.dirtyZone = [5000,0,5000,0,0];
      }
      //this.ctxL.clearRect(0,0,this.currentWidth + 200,this.height);

      let endx,x;
      for each (group in this.groupedData) {
        if (group.y < this.offsetTop || group.y - this.offsetTop > this.width) {
          continue;
        }
        if (group.active && group.timestamps[group.timestamps.length - 1] <= this.firstVisibleTime) {
          this.drawLine(0, group.y, group.id, this.currentWidth);
        }
        else if ((group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_END ||
                  group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_START ||
                  group.type == NORMALIZED_EVENT_TYPE.CONTINUOUS_EVENT_MID) &&
                 group.timestamps[group.timestamps.length - 1] >= this.firstVisibleTime &&
                 group.timestamps[0] <= this.lastVisibleTime) {
          x = (Math.max(group.timestamps[0], this.firstVisibleTime) - this.firstVisibleTime)/this.scale;
          if (!group.active) {
            endx = Math.min((group.timestamps[group.timestamps.length - 1] -
                            this.firstVisibleTime)/this.scale, this.currentWidth);
          }
          else {
            endx = this.currentWidth;
          }
          this.drawLine(x,group.y,group.id,endx);
        }
        else if (group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_STOP ||
                 group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_START ||
                 group.type == NORMALIZED_EVENT_TYPE.REPEATING_EVENT_MID) {
          for (let i = 0; i < group.timestamps.length; i++) {
            if (group.timestamps[i][group.timestamps[i].length - 1] >= this.firstVisibleTime &&
                group.timestamps[i][0] <= this.lastVisibleTime) {
              x = (Math.max(group.timestamps[i][0], this.firstVisibleTime) - this.firstVisibleTime)/this.scale;
              if (!group.active || i < group.timestamps.length - 1) {
                endx = Math.min((group.timestamps[i][group.timestamps[i].length - 1] -
                                this.firstVisibleTime)/this.scale, this.currentWidth);
              }
              else {
                endx = this.currentWidth;
              }
              this.drawLine(x,group.y,group.id,endx);
            }
          }
        }
      }

      // Move the left bar of the time window if the timeline is moving.
      if (this.timeWindowLeft != null && !this.timeFrozen) {
        let width_o = this.doc.getElementById("timeline-time-window").style.width.replace("px", "")*1;
        let left_o = this.doc.getElementById("timeline-time-window").style.left.replace("px", "")*1;
        let left = (Math.max(this.timeWindowLeft, this.firstVisibleTime) - this.firstVisibleTime)/this.scale;
        this.doc.getElementById("timeline-time-window").style.width = (width_o + left_o - left) + "px";
        this.doc.getElementById("timeline-time-window").style.left = left + "px";
      }

      if (this.linesDrawn == 0 && !this.scrolling && this.offsetTime == 0 &&
          !this.timeFrozen) {
        this.waitForLineData = true;
      }
    }
    if (!this.waitForDotData) {
      this.dotsDrawn = 0;

      this.ctxD.shadowOffsetY = 2;
      this.ctxD.shadowColor = "rgba(10,10,10,0.5)";
      this.ctxD.shadowBlur = 2;

      for each (let {x,y,id} in this.dirtyDots) {
        this.ctxD.clearRect(x-6,y-5,14,18);
      }
      this.dirtyDots = [];
      // if (this.offsetTime > 0 || this.scrollStartTime != null) {
        // this.ctxD.clearRect(0,0,this.width,this.height);
      // }
      // else {
        // this.ctxD.clearRect(0,0,0.5*this.width + (this.scrolling?
                            // (Date.now() - this.currentTime)/this.scale
                            // :this.offsetTime/this.scale) + 10,this.height);
      // }
      // getting the current time, which will be at the center of the canvas.

      let i = this.searchIndexForTime(this.lastVisibleTime);
      for (; i >= 0; i--) {
        if (this.globalTiming[i] >= this.firstVisibleTime) {
          this.drawDot((this.globalTiming[i] - this.firstVisibleTime)/this.scale,
                       this.groupedData[this.globalGroup[i]].y,
                       this.groupedData[this.globalGroup[i]].id);
        }
        // No need of going down further as time is already below visible state.
        else {
          break;
        }
      }

      if (this.dotsDrawn == 0 && !this.scrolling && this.offsetTime == 0) {
        this.waitForDotData = true;
      }
    }
    this.doc.defaultView.mozRequestAnimationFrame(this.render);
  }
};
